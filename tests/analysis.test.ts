import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AnalysisService } from '../server/analysis.js';
import { NoteDraftService } from '../server/note-drafts.js';
import { Store } from '../server/store.js';
import type { AIProvider, FlomoProvider } from '../server/provider-types.js';
import type { AnalysisCardInput, AnalysisKind, Memo, MemoSearch, Workspace } from '../shared/contracts.js';
import { analysisIsStale, formatAnalysisCard } from '../shared/analysis.js';

const memo = (id: string, overrides: Partial<Memo> = {}): Memo => ({id,url:`https://v.flomoapp.com/mine/?memo_id=${id}`,content:`完整笔记 ${id}`,
  tags:['想法','生态位'],created_at:'2026-09-29T00:00:00Z',updated_at:'2026-09-29T01:00:00Z',content_truncated:false,linked_memos:[],...overrides});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise,resolve};
}
class FakeFlomo implements FlomoProvider {
  memos = new Map<string,Memo>([['source',memo('source')]]);
  searches: MemoSearch[] = [];
  searchResults = new Map<string,Memo[]>();
  recommendations = new Map<string,Memo[]>();
  getCalls: string[] = [];
  relatedCalls: string[] = [];
  creates: string[] = [];
  searchGate?: ReturnType<typeof deferred>;
  createGate?: ReturnType<typeof deferred>;
  searchStarted = deferred();
  createStarted = deferred();
  uncertain = false;
  limited = false;
  async search(input: MemoSearch) {
    this.searches.push(input);this.searchStarted.resolve();
    await this.searchGate?.promise;
    return {memos:this.searchResults.get(input.query ?? '') ?? [],scope:'remote-search' as const,limit:input.limit ?? 20,possiblyLimited:this.limited,checkedAt:new Date().toISOString()};
  }
  async get(id: string) {
    this.getCalls.push(id);
    const result = this.memos.get(id);
    if (!result) throw new Error('missing');
    return structuredClone(result);
  }
  async related(id: string) { this.relatedCalls.push(id);return this.recommendations.get(id) ?? []; }
  async create(content: string) {
    this.creates.push(content);this.createStarted.resolve();
    await this.createGate?.promise;
    if (this.uncertain) throw new Error('network timeout after remote create');
    const result = memo(`new-${this.creates.length}`,{content,linked_memos:[...content.matchAll(/memo_id=([^\s]+)/g)].map(match => match[1])});
    this.memos.set(result.id,result);
    return result;
  }
  async tags() {return {tags:[],total:0,returned:0,truncated:false};}
  async update(id: string, content: string) {return memo(id,{content});}
}
async function fixture(t: TestContext, ai?: AIProvider) {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  const service = new AnalysisService(store,flomo,ai);
  const timestamp = new Date().toISOString();
  const workspace = await store.createWorkspace({id:'workspace',title:'生态位',memoId:'source',source:memo('source'),remote:null,sourceChanged:false,
    draft:'尚未发布的本地草稿',version:1,materials:[],messages:[],goal:'串联我的判断',analyses:[],createdAt:timestamp,updatedAt:timestamp,lastCheckedAt:timestamp},'web');
  t.after(async () => {flomo.searchGate?.resolve();flomo.createGate?.resolve();await service.close();await store.close();});
  return {store,flomo,service,workspace};
}
const creation = (workspace: Workspace, kind: AnalysisKind = 'insights', key = 'request') => ({kind,question:'这些判断如何相互联系？',engine:'external' as const,baseVersion:workspace.version,idempotencyKey:key});
async function preparedCards(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  const workspace = await f.store.getWorkspace(f.workspace.id);
  const prepared = await f.service.create(workspace.id,creation(workspace,'cards'),'mcp');
  const record = prepared.analyses!.at(-1)!;
  const inputs: AnalysisCardInput[] = Array.from({length:count},(_,index) => ({title:`能力优势需要需求验证 ${index}`,body:'这是一个待验证的判断。',tags:['想法','生态位'],sourceKeys:['flomo:source']}));
  return f.service.complete(workspace.id,record.id,{text:JSON.stringify({cards:inputs}),cards:inputs,baseVersion:prepared.version},'mcp');
}

test('topic discovery searches terms separately, fully reads/deduplicates candidates, filters related notes and preserves choices/draft', async t => {
  const f = await fixture(t);
  for (const value of [memo('a'),memo('b'),memo('related'),memo('excluded',{tags:['资源']}),memo('old',{created_at:'2025-01-01'})]) f.flomo.memos.set(value.id,value);
  f.flomo.searchResults.set('生态位',[memo('a',{content:'截断',content_truncated:true}),memo('b')]);
  f.flomo.searchResults.set('定位',[memo('b')]);
  f.flomo.recommendations.set('a',[memo('related'),memo('excluded',{tags:['资源']}),memo('old',{created_at:'2025-01-01'})]);
  const selected = memo('b',{content:'已明确选择的旧快照'});
  const initial = await f.store.updateWorkspace(f.workspace.id,1,'web','materials',w => ({...w,materials:[selected],materialCandidates:[{memo:selected,reason:'用户选用',relation:'support',status:'selected'}]}));
  const result = await f.service.discover(initial.id,{terms:['生态位','定位','生态位'],tag:'想法',startDate:'2026-01-01',limit:20,baseVersion:initial.version},'web');
  assert.deepEqual(f.flomo.searches.map(item => item.query),['生态位','定位']);
  assert.deepEqual(f.flomo.getCalls,['a','b','related']);
  assert.equal(result.readCount,3);
  assert.deepEqual(result.omitted.map(item => item.memoId),['excluded','old']);
  assert.deepEqual(result.workspace.materials,[selected]);
  assert.equal(result.workspace.materialCandidates!.find(item => item.memo.id === 'b')!.status,'selected');
  assert.equal(result.workspace.materialCandidates!.find(item => item.memo.id === 'b')!.relation,'support');
  assert.equal(result.workspace.materialCandidates!.find(item => item.memo.id === 'a')!.memo.content,'完整笔记 a');
  assert.equal(result.workspace.materialCandidates!.find(item => item.memo.id === 'related')!.status,'proposed');
  assert.equal(result.workspace.draft,f.workspace.draft);
});

test('discovery reports capped and unreadable scope, and an empty discovery does not mutate workspace', async t => {
  const f = await fixture(t);
  f.flomo.searchResults.set('主题',[memo('missing'),memo('capped')]);
  const result = await f.service.discover(f.workspace.id,{terms:['主题'],limit:1,baseVersion:1},'mcp');
  assert.equal(result.possiblyLimited,true);
  assert.equal(result.readCount,0);
  assert.equal(result.workspace.version,1);
  assert.deepEqual(result.omitted.map(item => item.memoId),['capped','missing']);
  assert.deepEqual(result.workspace.materialCandidates,[]);
});

test('discovery checks versions before network requests and again before saving results', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.discover(f.workspace.id,{terms:['主题'],limit:10,baseVersion:2},'cli'),{code:'VERSION_CONFLICT'});
  assert.equal(f.flomo.searches.length,0);
  f.flomo.searchGate = deferred();
  f.flomo.memos.set('a',memo('a'));f.flomo.searchResults.set('主题',[memo('a')]);
  const pending = f.service.discover(f.workspace.id,{terms:['主题'],limit:10,baseVersion:1},'cli');
  await f.flomo.searchStarted.promise;
  await f.store.updateWorkspace(f.workspace.id,1,'web','draft',w => ({...w,draft:'用户继续写作'}));
  f.flomo.searchGate.resolve();
  await assert.rejects(pending,{code:'VERSION_CONFLICT'});
  assert.equal((await f.store.getWorkspace(f.workspace.id)).draft,'用户继续写作');
  assert.deepEqual((await f.store.getWorkspace(f.workspace.id)).materialCandidates,[]);
});

test('external analyses preserve exact selected evidence, offer instructions without AI and detect later stale scope', async t => {
  const f = await fixture(t);
  const initial = await f.store.updateWorkspace(f.workspace.id,1,'web','materials',w => ({...w,
    materials:[memo('selected')],materialCandidates:[{memo:memo('ignored'),status:'proposed',reason:'未选用',relation:'background'}],
    collectorMaterials:[{kind:'collector',article:{id:'article',title:'外部观点',sourceUrl:'https://example.com/source',summary:'短摘要',digest:'概要',content:'完整原文',contentTruncated:false,updatedAt:'2026-09-29'},memoIds:['source'],fetchedAt:'2026-09-29'}],
    messages:[{id:'chat',role:'assistant',content:'旧推测',actor:'web',createdAt:'2026-09-29'}],
  }));
  const created = await f.service.create(initial.id,creation(initial,'evolution'),'mcp');
  const record = created.analyses![0];
  assert.equal(record.status,'prepared');assert.equal(record.workspaceVersion,initial.version);
  assert.deepEqual(record.sources.map(source => source.key),['collector:article','flomo:selected','flomo:source']);
  assert.equal(record.sources.find(source => source.kind === 'collector')!.content,'完整原文');
  assert.match(record.instructions,/区分.*收藏时间/);
  assert.doesNotMatch(record.instructions,/旧推测|未选用|尚未发布的本地草稿/);
  assert.equal(record.inputFingerprint.length,64);
  assert.equal(analysisIsStale(record,created),false);
  const changed = await f.store.updateWorkspace(initial.id,created.version,'web','goal',w => ({...w,goal:'新的问题'}));
  assert.equal(analysisIsStale(record,changed),true);
  assert.equal(changed.analyses![0].goal,initial.goal);
  const finished = await f.service.complete(initial.id,record.id,{text:'材料不足，尚不能判断个人立场变化。',baseVersion:changed.version},'mcp');
  assert.equal(finished.analyses![0].status,'succeeded');
  assert.equal(finished.draft,f.workspace.draft);
});

test('analysis creation is idempotent, rejects different requests with a reused key and retains old records at the cap', async t => {
  const f = await fixture(t);
  const [first,retry] = await Promise.all([f.service.create(f.workspace.id,creation(f.workspace),'web'),f.service.create(f.workspace.id,creation(f.workspace),'mcp')]);
  assert.equal(first.analyses![0].id,retry.analyses![0].id);
  assert.equal(retry.version,2);
  await assert.rejects(f.service.create(f.workspace.id,{...creation(f.workspace),kind:'outline'},'web'),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.create(f.workspace.id,creation(retry),'web'),{code:'IDEMPOTENCY_CONFLICT'});
  let current = retry;
  for (let index = 1;index < 12;index++) current = await f.service.create(current.id,creation(current,'insights',`request-${index}`),'web');
  await assert.rejects(f.service.create(current.id,creation(current,'insights','over-limit'),'web'),{code:'ANALYSIS_LIMIT'});
  assert.equal((await f.store.getWorkspace(current.id)).analyses!.length,12);
});

test('truncated, empty and oversized evidence is rejected without creating partial analyses', async t => {
  const cases: ((workspace: Workspace) => Workspace)[] = [
    w => ({...w,source:{...w.source,content_truncated:true}}),
    w => ({...w,materials:[memo('empty',{content:' '})]}),
    w => ({...w,source:{...w.source,content:'长'.repeat(121000)}}),
    w => ({...w,collectorMaterials:[{kind:'collector',article:{id:'a',title:'a',sourceUrl:'https://example.com',content:'partial',contentTruncated:true,summary:'s',digest:'d',updatedAt:''},memoIds:[],fetchedAt:''}]}),
  ];
  for (const transform of cases) await t.test('invalid input',async t => {
    const f = await fixture(t);
    const changed = await f.store.updateWorkspace(f.workspace.id,1,'web','sources',transform);
    await assert.rejects(f.service.create(changed.id,creation(changed),'web'));
    assert.equal((await f.store.getWorkspace(changed.id)).analyses!.length,0);
  });
});

test('builtin analysis uses sanitized fixed inputs and completion preserves concurrent user edits', async t => {
  const started = deferred(), gate = deferred();
  let captured: Workspace | undefined;
  const f = await fixture(t,{async generate(snapshot,prompt,onChunk) {
    captured = snapshot;
    assert.match(prompt,/flomo:source/);
    await onChunk('根据材料');started.resolve();await gate.promise;
    await onChunk('尚不能得出普遍结论。');
    return '根据材料尚不能得出普遍结论。';
  }});
  t.after(() => gate.resolve());
  const withNewDraft = await new NoteDraftService(f.store,f.flomo).create(f.workspace.id,{title:'未发表的新想法',content:'未验证的新判断',baseVersion:1,idempotencyKey:'new-draft'},'web');
  const prepared = await f.service.create(f.workspace.id,{...creation(withNewDraft),engine:'builtin'},'web');
  await started.promise;
  assert.equal(captured!.draft,'');assert.deepEqual(captured!.messages,[]);assert.deepEqual(captured!.analyses,[]);assert.deepEqual(captured!.noteDrafts,[]);
  assert.equal(captured!.source.content,f.workspace.source.content);
  await f.store.updateWorkspace(prepared.id,prepared.version,'cli','draft',w => ({...w,draft:'生成时新增的用户草稿'}));
  gate.resolve();await f.service.settle();
  const final = await f.store.getWorkspace(prepared.id);
  assert.equal(final.analyses![0].status,'succeeded');assert.equal(final.analyses![0].sources[0].content,f.workspace.source.content);
  assert.equal(final.draft,'生成时新增的用户草稿');
  assert.equal(final.noteDrafts![0].content,'未验证的新判断');
  const revisions = await f.store.listDraftRevisions(final.id);
  assert.equal(revisions.length,1);
});

test('invalid generated card JSON and fabricated sources fail safely without creating remote notes', async t => {
  for (const output of ['不是卡片 JSON',JSON.stringify({cards:[{title:'判断',body:'依据',tags:['想法'],sourceKeys:['flomo:invented']}]})]) await t.test(output.slice(0,20),async t => {
    const f = await fixture(t,{async generate() {return output;}});
    await f.service.create(f.workspace.id,{...creation(f.workspace,'cards'),engine:'builtin'},'web');
    await f.service.settle();
    const final = await f.store.getWorkspace(f.workspace.id);
    assert.equal(final.analyses![0].status,'failed');assert.deepEqual(final.analyses![0].cards,[]);assert.equal(f.flomo.creates.length,0);
  });
});

test('external completion validates mode, fabricated references and card tags, and accepts a fenced card JSON', async t => {
  const f = await fixture(t);
  const prepared = await f.service.create(f.workspace.id,creation(f.workspace,'cards'),'mcp');
  const record = prepared.analyses![0];
  const valid = {title:'判断',body:'理由',tags:['想法'],sourceKeys:['flomo:source']};
  await assert.rejects(f.service.complete(prepared.id,record.id,{text:'bad',cards:[{...valid,sourceKeys:['flomo:fake']}],baseVersion:prepared.version},'mcp'),{code:'INVALID_ANALYSIS_SOURCE'});
  await assert.rejects(f.service.complete(prepared.id,record.id,{text:'bad',cards:[{...valid,tags:['#bad tag']}],baseVersion:prepared.version},'mcp'));
  const done = await f.service.complete(prepared.id,record.id,{text:'```json\n'+JSON.stringify({cards:[valid]})+'\n```',baseVersion:prepared.version},'mcp');
  assert.equal(done.analyses![0].cards.length,1);assert.equal(done.analyses![0].cards[0].reviewedAt,undefined);
  const repeated = await f.service.complete(prepared.id,record.id,{text:done.analyses![0].output,baseVersion:prepared.version},'cli');
  assert.equal(repeated.version,done.version);
  assert.equal(repeated.analyses![0].cards[0].id,done.analyses![0].cards[0].id);
  await assert.rejects(f.service.complete(done.id,record.id,{text:'overwrite',baseVersion:done.version},'mcp'),{code:'ANALYSIS_NOT_PREPARED'});
});

test('card extraction requires a completed current analysis as basis', async t => {
  const f = await fixture(t);
  let current = await f.service.create(f.workspace.id,creation(f.workspace),'mcp');
  const basis = current.analyses![0];
  await assert.rejects(f.service.create(current.id,{...creation(current,'cards','cards'),basisAnalysisId:basis.id},'mcp'),{code:'ANALYSIS_NOT_COMPLETE'});
  current = await f.service.complete(current.id,basis.id,{text:'初步判断',baseVersion:current.version},'mcp');
  const cards = await f.service.create(current.id,{...creation(current,'cards','cards'),basisAnalysisId:basis.id},'mcp');
  assert.match(cards.analyses![1].instructions,/初步判断/);
  current = await f.store.updateWorkspace(cards.id,cards.version,'web','goal',w => ({...w,goal:'新的目标'}));
  await assert.rejects(f.service.create(current.id,{...creation(current,'cards','cards-new'),basisAnalysisId:basis.id},'mcp'),{code:'ANALYSIS_STALE'});
});

test('cards require saved review, preserve all sources, publish once across concurrent keys and retain concurrent draft edits', async t => {
  const f = await fixture(t);
  await f.store.updateWorkspace(f.workspace.id,1,'web','materials',w => ({...w,materials:[memo('selected')]}));
  let current = await preparedCards(f);
  const record = current.analyses![0], card = record.cards[0];
  await assert.rejects(f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'publish'},'web'),{code:'CARD_REVIEW_REQUIRED'});
  current = await f.service.updateCard(current.id,record.id,card.id,{title:'审阅后的判断',body:'具体理由',tags:['想法'],sourceKeys:['flomo:selected'],baseVersion:current.version},'web');
  assert.deepEqual(current.analyses![0].cards[0].sourceKeys,['flomo:source','flomo:selected']);
  assert.ok(current.analyses![0].cards[0].reviewedAt);
  const expected = formatAnalysisCard(current.analyses![0].cards[0],current.analyses![0].sources);
  f.flomo.createGate = deferred();
  const [first,retry] = await Promise.all([
    f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'publish'},'web'),
    f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'publish-another'},'mcp'),
  ]);
  await f.flomo.createStarted.promise;
  assert.equal(first.analyses![0].cards[0].status,'publishing');assert.equal(retry.analyses![0].cards[0].status,'publishing');
  await f.store.updateWorkspace(current.id,first.version,'web','draft',w => ({...w,draft:'创建卡片时保留的新草稿'}));
  f.flomo.createGate.resolve();await f.service.settle();
  const done = await f.store.getWorkspace(current.id);
  assert.equal(done.analyses![0].cards[0].status,'published');assert.equal(done.draft,'创建卡片时保留的新草稿');
  assert.equal(f.flomo.creates.length,1);assert.equal(f.flomo.creates[0],expected);
  assert.match(f.flomo.creates[0],/memo_id=source/);assert.match(f.flomo.creates[0],/memo_id=selected/);
  await f.service.publishCard(done.id,record.id,card.id,{baseVersion:1,idempotencyKey:'brand-new'},'cli');
  await f.service.settle();assert.equal(f.flomo.creates.length,1);
  await assert.rejects(f.service.updateCard(done.id,record.id,card.id,{...card,title:'change after publication',baseVersion:done.version},'web'));
});

test('uncertain publication cannot be retried with a new key and keys cannot be reused for another card', async t => {
  const f = await fixture(t);
  let current = await preparedCards(f,2);
  const record = current.analyses![0];
  for (const card of record.cards) current = await f.service.updateCard(current.id,record.id,card.id,{title:card.title,body:card.body,tags:card.tags,sourceKeys:card.sourceKeys,baseVersion:current.version},'web');
  f.flomo.uncertain = true;
  await f.service.publishCard(current.id,record.id,record.cards[0].id,{baseVersion:current.version,idempotencyKey:'once'},'web');
  await f.service.settle();current = await f.store.getWorkspace(current.id);
  assert.equal(current.analyses![0].cards[0].status,'uncertain');
  await f.service.publishCard(current.id,record.id,record.cards[0].id,{baseVersion:current.version,idempotencyKey:'different'},'web');
  await assert.rejects(f.service.publishCard(current.id,record.id,record.cards[1].id,{baseVersion:current.version,idempotencyKey:'once'},'web'),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.flomo.creates.length,1);
});

test('restart recovery marks interrupted analyses failed and card creation uncertain without remote calls', async t => {
  const f = await fixture(t);
  const current = await preparedCards(f);
  await f.store.updateWorkspace(current.id,current.version,'web','simulate-interruption',w => ({...w,analyses:w.analyses!.map(record => ({...record,status:'running',cards:record.cards.map(card => ({...card,status:'publishing',publicationKey:'interrupted',publicationHash:'hash'}))}))}));
  const restarted = new AnalysisService(f.store,f.flomo);
  await restarted.recover();
  const recovered = await f.store.getWorkspace(current.id);
  assert.equal(recovered.analyses![0].status,'failed');assert.equal(recovered.analyses![0].cards[0].status,'uncertain');
  assert.equal(recovered.draft,f.workspace.draft);assert.equal(f.flomo.creates.length,0);
  await restarted.recover();assert.equal((await f.store.getWorkspace(current.id)).version,recovered.version);
});

test('analysis and card bodies reject a real source key attached to a fabricated URL', async t => {
  const f = await fixture(t);
  const prepared = await f.service.create(f.workspace.id,creation(f.workspace),'mcp');
  await assert.rejects(f.service.complete(prepared.id,prepared.analyses![0].id,{text:'见 [flomo:source](https://fake.example.com/)',baseVersion:prepared.version},'mcp'),{code:'INVALID_ANALYSIS_SOURCE'});
  const succeeded = await f.service.complete(prepared.id,prepared.analyses![0].id,{text:'见 [flomo:source](https://v.flomoapp.com/mine/?memo_id=source)',baseVersion:prepared.version},'mcp');
  const cards = await f.service.create(succeeded.id,creation(succeeded,'cards','cards'),'mcp');
  await assert.rejects(f.service.complete(cards.id,cards.analyses![1].id,{text:'卡片',cards:[{title:'判断',body:'见 [flomo:source](https://fake.example.com/)',tags:[],sourceKeys:['flomo:source']}],baseVersion:cards.version},'mcp'),{code:'INVALID_ANALYSIS_SOURCE'});
});

test('publication counts source links toward the remote length limit before any create call', async t => {
  const f = await fixture(t);
  const long = memo('source',{url:'https://example.com/'+ 'a'.repeat(19000)});
  await f.store.updateWorkspace(f.workspace.id,1,'web','sources',w => ({...w,source:long}));
  let current = await preparedCards(f);
  const record = current.analyses![0], card = record.cards[0];
  current = await f.service.updateCard(current.id,record.id,card.id,{title:card.title,body:'文'.repeat(2000),tags:card.tags,sourceKeys:card.sourceKeys,baseVersion:current.version},'web');
  await assert.rejects(f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'too-long'},'web'),{code:'CARD_CONTENT_LIMIT'});
  assert.equal(f.flomo.creates.length,0);assert.equal((await f.store.getWorkspace(current.id)).analyses![0].cards[0].status,'draft');
});

test('publication is uncertain when a fresh remote read has lost a required source link', async t => {
  const f = await fixture(t);
  let current = await preparedCards(f);
  const record = current.analyses![0], card = record.cards[0];
  current = await f.service.updateCard(current.id,record.id,card.id,{title:card.title,body:card.body,tags:card.tags,sourceKeys:card.sourceKeys,baseVersion:current.version},'web');
  f.flomo.get = async id => memo(id,{content:'远端只保留了正文',linked_memos:[]});
  await f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'publish'},'web');
  await f.service.settle();
  const stored = (await f.store.getWorkspace(current.id)).analyses![0].cards[0];
  assert.equal(stored.status,'uncertain');assert.equal(stored.resultMemo!.id,'new-1');assert.equal(f.flomo.creates.length,1);
});

test('publication is uncertain when remote body changes even if all source links remain', async t => {
  const f = await fixture(t);
  let current = await preparedCards(f);
  const record = current.analyses![0], card = record.cards[0];
  current = await f.service.updateCard(current.id,record.id,card.id,{title:card.title,body:card.body,tags:card.tags,sourceKeys:card.sourceKeys,baseVersion:current.version},'web');
  f.flomo.get = async id => memo(id,{content:'被截断的正文\nhttps://v.flomoapp.com/mine/?memo_id=source',linked_memos:['source']});
  await f.service.publishCard(current.id,record.id,card.id,{baseVersion:current.version,idempotencyKey:'publish'},'web');
  await f.service.settle();
  const stored = (await f.store.getWorkspace(current.id)).analyses![0].cards[0];
  assert.equal(stored.status,'uncertain');assert.equal(stored.resultMemo!.id,'new-1');assert.equal(f.flomo.creates.length,1);
});

test('guided writing preserves answers and edited outline, permits finding new materials between questions and outline, and rejects stale paragraph bases', async t => {
  const f = await fixture(t);
  const writing = {stage:'questions' as const,claim:'生态位需要需求验证',audience:'独立创作者',answers:'我的经验，仍需验证',structure:'direct' as const,outline:'',section:''};
  let w = await f.service.create(f.workspace.id,{...creation(f.workspace),writing},'web');
  const q = w.analyses!.at(-1)!;
  assert.deepEqual(q.writing,writing);
  assert.match(q.instructions,/不能冒充已证实事实/);
  w = await f.service.complete(w.id,q.id,{text:'需求来自谁？',baseVersion:w.version},'mcp');
  w = await f.store.updateWorkspace(w.id,w.version,'web','materials',v=>({...v,materials:[memo('evidence')]}));
  w = await f.service.create(w.id,{...creation(w,'outline','outline'),writing:{...writing,stage:'outline'},basisAnalysisId:q.id},'web');
  const outline = w.analyses!.at(-1)!;
  assert.equal(outline.sources.length,2);
  w = await f.service.complete(w.id,outline.id,{text:'一、验证需求',baseVersion:w.version},'mcp');
  const paragraph = { ...writing,stage:'paragraph' as const,outline:'一、先定义需求\n二、验证需求',section:'先定义需求'};
  const request = {...creation(w,'outline','paragraph'),writing:paragraph,basisAnalysisId:outline.id};
  w = await f.service.create(w.id,request,'web');
  assert.match(w.analyses!.at(-1)!.instructions,/先定义需求/);
  assert.equal(w.draft,f.workspace.draft);
  assert.equal(f.flomo.creates.length,0);
  assert.equal((await f.service.create(w.id,request,'web')).version,w.version);
  await assert.rejects(f.service.create(w.id,{...request,writing:{...paragraph,section:'另一个段落'}},'web'),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.create(w.id,{...creation(w,'outline','changed'),writing:{...paragraph,answers:'新补充'},basisAnalysisId:outline.id},'web'),{code:'WRITING_CHANGED'});
  w = await f.store.updateWorkspace(w.id,w.version,'web','goal',v=>({...v,goal:'新的目标'}));
  await assert.rejects(f.service.create(w.id,{...creation(w,'outline','stale'),writing:paragraph,basisAnalysisId:outline.id},'web'),{code:'ANALYSIS_STALE'});
  await assert.rejects(f.service.create(w.id,{...creation(w,'outline','missing'),writing:paragraph},'web'),{code:'INVALID_WRITING'});
});
