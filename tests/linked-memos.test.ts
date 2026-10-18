import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Memo, MemoSearch, SearchResult } from '../shared/contracts.js';
import type { FlomoProvider } from '../server/provider-types.js';
import { linkedMemoIds } from '../server/memo-links.js';
import { resolveLinkedMemos } from '../server/linked-memos.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';
import { discussionInput } from '../shared/discussion.js';

const memo = (id:string, content = `完整正文 ${id}`, links:string[] = []):Memo => ({id,content,
  url:`https://v.flomoapp.com/mine/?memo_id=${id}`,tags:[],created_at:'',updated_at:'',content_truncated:false,linked_memos:links});
class FakeFlomo implements FlomoProvider {
  memos = new Map<string,Memo>();
  previews:Memo[] = [];
  reads:string[] = [];
  searches:MemoSearch[] = [];
  possiblyLimited = false;
  searchFailure = false;
  async get(id:string) {
    this.reads.push(id);
    const value = this.memos.get(id);
    if (!value) throw new Error('private upstream credential');
    return structuredClone(value);
  }
  async search(input:MemoSearch):Promise<SearchResult> {
    this.searches.push(input);
    if (this.searchFailure) throw new Error('private upstream credential');
    return {memos:structuredClone(this.previews),limit:input.limit ?? 30,possiblyLimited:this.possiblyLimited,scope:'remote-search',checkedAt:''};
  }
  async tags() { return {tags:[],total:0,returned:0,truncated:false}; }
  async related():Promise<Memo[]> { throw new Error('recommendations must not count as links'); }
  async update():Promise<Memo> { throw new Error('association reads must not write'); }
}

test('canonical memo references handle escaped links, deduplicate, and reject lookalike URLs and bare IDs', () => {
  const source = memo('source',String.raw`
https://v.flomoapp.com/mine/?memo\_id=escaped
[关联](https://v.flomoapp.com/mine/?memo_id=linked)
https://v.flomoapp.com/mine/?other=1\&memo\_id=amp
https://v.flomoapp.com.evil.org/mine/?memo_id=evil
https://v.flomoapp.com@evil.org/mine/?memo_id=evil
https://user:password@v.flomoapp.com/mine/?memo_id=evil
https://v.flomoapp.com:444/mine/?memo_id=evil
http://v.flomoapp.com/mine/?memo_id=evil
https://v.flomoapp.com/other/?memo_id=evil
https://v.flomoapp.com/mine/?memo_id=evil&memo_id=linked
https://v.flomoapp.com/mine/?memo_id=bad%2Fid
bare-id
`,['linked','provider','provider','../invalid']);
  assert.deepEqual(linkedMemoIds(source),['linked','provider','escaped','amp']);
});

test('direct, inverse, and bidirectional associations resolve full bodies once without following another hop', async () => {
  const flomo = new FakeFlomo();
  const source = memo('source','[文字关联](https://v.flomoapp.com/mine/?memo_id=direct)',['both','direct','source']);
  flomo.memos.set('both',memo('both','双向完整正文',['source','other-hop']));
  flomo.memos.set('direct',memo('direct','直接完整正文',['other-hop']));
  flomo.memos.set('inverse',memo('inverse',String.raw`反向完整正文 https://v.flomoapp.com/mine/?memo\_id=source`));
  flomo.memos.set('hidden',memo('hidden','摘要未显示的链接',['source']));
  flomo.memos.set('removed',memo('removed','旧链接已删除'));
  flomo.previews = [source,memo('both','双向摘要',['source']),memo('inverse','反向摘要',['source']),
    memo('inverse','重复摘要',['source']),memo('removed','旧摘要',['source']),
    {...memo('hidden','截断摘要'),content_truncated:true},memo('bare','仅提及 source，不是关联')];

  const result = await resolveLinkedMemos(source,flomo);
  assert.deepEqual(result.items.map(item => [item.id,item.direction,item.status]),[
    ['both','bidirectional','available'],['direct','outgoing','available'],['inverse','incoming','available'],['hidden','incoming','available'],
  ]);
  assert.equal(result.items[0].memo!.content,'双向完整正文');
  assert.equal(result.items[2].memo!.content,flomo.memos.get('inverse')!.content);
  assert.deepEqual(flomo.reads,['both','direct','inverse','removed','hidden']);
  assert.deepEqual(flomo.searches,[{query:'source',limit:50}]);
  assert.equal(result.truncated,false);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.deepEqual(result.warnings,[]);
});

test('missing, partial, empty, oversized and mismatched target notes cannot expose a substitute body or fail the list', async () => {
  const flomo = new FakeFlomo();
  flomo.memos.set('valid',memo('valid'));
  flomo.memos.set('partial',{...memo('partial'),content_truncated:true});
  flomo.memos.set('empty',memo('empty','  '));
  flomo.memos.set('large',memo('large','x'.repeat(500_001)));
  flomo.memos.set('mismatch',memo('another','private unrelated body'));
  const result = await resolveLinkedMemos(memo('source','正文',['valid','missing','partial','empty','large','mismatch']),flomo);
  assert.deepEqual(result.items.map(item => item.status),['available','unavailable','unavailable','unavailable','unavailable','unavailable']);
  assert.ok(result.items.slice(1).every(item => item.message && !item.memo));
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('failed inverse reads retain confirmed references but do not invent unverified associations', async () => {
  const flomo = new FakeFlomo();
  flomo.previews = [memo('confirmed','反向摘要',['source']),{...memo('unknown'),content_truncated:true}];
  const result = await resolveLinkedMemos(memo('source'),flomo);
  assert.deepEqual(result.items.map(item => [item.id,item.direction,item.status]),[['confirmed','incoming','unavailable']]);
  assert.equal(result.truncated,true);
  assert.match(result.warnings.join(' '),/尚未核实/);
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('one-hop reads and search candidates are bounded and report incomplete coverage', async () => {
  const flomo = new FakeFlomo();
  const ids = Array.from({length:35},(_,i) => `direct-${i}`);
  for (const id of ids) flomo.memos.set(id,memo(id));
  flomo.previews = Array.from({length:60},(_,i) => memo(`incoming-${i}`,'反向',['source']));
  const result = await resolveLinkedMemos(memo('source','正文',ids),flomo);
  assert.equal(result.items.length,30);
  assert.deepEqual(flomo.reads,ids.slice(0,30));
  assert.equal(result.truncated,true);
  assert.match(result.warnings.join(' '),/30/);
  assert.match(result.warnings.join(' '),/反向关联搜索结果/);
});

test('inverse search failure still returns outgoing content and a sanitized warning', async () => {
  const flomo = new FakeFlomo();
  flomo.searchFailure = true;
  flomo.memos.set('direct',memo('direct'));
  const result = await resolveLinkedMemos(memo('source','正文',['direct']),flomo);
  assert.equal(result.items[0].memo!.content,'完整正文 direct');
  assert.equal(result.truncated,true);
  assert.match(result.warnings.join(' '),/暂时无法检查反向关联/);
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('GET reads fresh associations and their removal without selecting materials, changing drafts, or recording writes', async () => {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  flomo.memos.set('source',memo('source','旧正文',['old']));
  flomo.memos.set('latest',memo('latest','应显示的完整正文'));
  const service = new WorkbenchService(store,flomo);
  const app = await createApp({service});
  try {
    const created = await service.createWorkspace('source',undefined,'web');
    const before = await store.updateWorkspace(created.id,created.version,'web','refreshed',workspace => ({...workspace,
      remote:memo('source','已保存正文',['previous']),sourceChanged:true,draft:'未保存的写作内容'}));
    const changes = await store.changes();
    flomo.memos.set('source',memo('source','最新正文',['latest']));
    flomo.reads = [];
    const response = await app.inject({method:'GET',url:`/api/v1/workspaces/${created.id}/linked-memos`});
    assert.equal(response.statusCode,200);
    assert.deepEqual(response.json().items.map((item:{id:string}) => item.id),['latest']);
    assert.deepEqual(flomo.reads,['source','latest']);
    assert.equal(response.json().truncated,false);
    assert.deepEqual(response.json().warnings,[]);
    flomo.memos.set('source',memo('source','关联已删除'));
    const removed = await app.inject({method:'GET',url:`/api/v1/workspaces/${created.id}/linked-memos`});
    assert.equal(removed.statusCode,200);
    assert.deepEqual(removed.json().items,[]);
    assert.deepEqual(await store.getWorkspace(created.id),before);
    assert.deepEqual(await store.changes(),changes);
    assert.deepEqual(await store.listJobs(),[]);
    const missing = await app.inject({method:'GET',url:'/api/v1/workspaces/nonexistent/linked-memos'});
    assert.equal(missing.statusCode,404);
    const untrusted = await app.inject({method:'GET',url:`/api/v1/workspaces/${created.id}/linked-memos`,headers:{origin:'https://evil.org'}});
    assert.equal(untrusted.statusCode,403);
  } finally { await app.close(); await service.close(); await store.close(); }
});

test('failed or invalid fresh source reads explicitly fall back to the saved version without leaking unrelated content', async () => {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  flomo.memos.set('source',memo('source','原始正文',['old']));
  flomo.memos.set('saved',memo('saved','保存版本关联的完整正文'));
  const service = new WorkbenchService(store,flomo);
  try {
    const created = await service.createWorkspace('source',undefined,'web');
    const before = await store.updateWorkspace(created.id,created.version,'web','refreshed',workspace => ({...workspace,
      remote:memo('source','已保存的远端正文',['saved']),draft:'保留草稿'}));
    const changes = await store.changes();
    const invalidSources = [undefined,memo('another','private unrelated source',['unrelated']),
      {...memo('source','partial'),content_truncated:true},memo('source','  ')];
    for (const invalid of invalidSources) {
      if (invalid) flomo.memos.set('source',invalid);
      else flomo.memos.delete('source');
      const result = await service.resolveLinkedMemos(created.id);
      assert.deepEqual(result.items.map(item => item.id),['saved']);
      assert.equal(result.truncated,true);
      assert.match(result.warnings.join(' '),/已保存版本/);
      assert.equal(JSON.stringify(result).includes('private'),false);
    }
    assert.deepEqual(await store.getWorkspace(created.id),before);
    assert.deepEqual(await store.changes(),changes);
  } finally { await service.close(); await store.close(); }
});

test('selecting an association replaces stale truncated candidate text with full content in materials and discussion input', async () => {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  flomo.memos.set('source',memo('source','当前笔记',['linked']));
  const full = memo('linked','最新完整正文\n\n旧候选预览中缺失的后续内容。');
  flomo.memos.set('linked',full);
  const service = new WorkbenchService(store,flomo);
  try {
    const created = await service.createWorkspace('source',undefined,'web');
    const before = await store.updateWorkspace(created.id,created.version,'web','candidates',workspace => ({...workspace,
      materialCandidates:[{memo:{...memo('linked','旧的截断预览'),content_truncated:true},reason:'作为背景',relation:'background',status:'proposed'}]}));
    const selected = await service.setMaterials(before.id,['linked'],before.version,'web');
    assert.deepEqual(selected.materials,[full]);
    assert.deepEqual(selected.materialCandidates![0].memo,full);
    assert.equal(selected.materialCandidates![0].status,'selected');
    const context = discussionInput(selected).materials.find(item => item.kind === 'flomo' && item.id === 'linked');
    assert.equal(context!.content,full.content);
    assert.equal(context!.contentTruncated,false);
  } finally { await service.close(); await store.close(); }
});
