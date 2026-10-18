import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { ProviderError, type AIProvider, type FlomoProvider } from '../server/provider-types.js';
import { WorkbenchService } from '../server/service.js';
import { Store } from '../server/store.js';
import type { Memo, MemoSearch, Workspace } from '../shared/contracts.js';

const memo = (id: string, overrides: Partial<Memo> = {}): Memo => ({
  id, url:`https://v.flomoapp.com/mine/?memo_id=${id}`, content:`完整正文 ${id}：能力需要在具体需求中验证。`,
  tags:['想法','生态位'], created_at:'2026-09-29T00:00:00Z', updated_at:'2026-09-29T01:00:00Z',
  content_truncated:false, linked_memos:[], ...overrides,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise,resolve};
}
class FakeFlomo implements FlomoProvider {
  memos = new Map<string,Memo>();
  searchResults = new Map<string,Memo[]>();
  recommendations = new Map<string,Memo[]>();
  searches: MemoSearch[] = [];
  getCalls: string[] = [];
  relatedCalls: string[] = [];
  async search(input: MemoSearch) {
    this.searches.push(input);
    return {memos:this.searchResults.get(input.query ?? '') ?? [],scope:'remote-search' as const,
      limit:input.limit ?? 20,possiblyLimited:false,checkedAt:''};
  }
  async get(id: string) {
    this.getCalls.push(id);
    const found = this.memos.get(id);
    if (!found) throw new Error('Full memo is unavailable');
    return structuredClone(found);
  }
  async related(id: string) { this.relatedCalls.push(id);return this.recommendations.get(id) ?? []; }
  async tags() { return {tags:[],total:0,returned:0,truncated:false}; }
  async update(): Promise<Memo> { throw new Error('Discovery must never update flomo'); }
}
type Generation = {workspace:Workspace;prompt:string};
type AIReply = string | ((call: Generation) => Promise<string> | string);
class ScriptedAI implements AIProvider {
  calls: Generation[] = [];
  constructor(readonly replies: AIReply[]) {}
  async generate(workspace: Workspace, prompt: string, onChunk: (text: string) => void | Promise<void>) {
    const call = {workspace:structuredClone(workspace),prompt};
    this.calls.push(call);
    const reply = this.replies.shift();
    assert.notEqual(reply,undefined,'Unexpected additional AI request');
    const output = typeof reply === 'function' ? await reply(call) : reply!;
    await onChunk(output);
    return output;
  }
}
const plan = JSON.stringify({terms:['生态位','定位']});
const recommendation = (memoId: string, relation = 'support') => ({memoId,reason:`${memoId} 的全文提供了验证核心判断的具体依据。`,relation});
const ranking = (recommendations: ReturnType<typeof recommendation>[]) => JSON.stringify({summary:'找到可以补足论据与边界的材料。',recommendations});
const input = (workspace: Workspace) => ({instruction:'寻找具体例子和反例',limit:20,baseVersion:workspace.version});
async function fixture(t: TestContext, ai?: AIProvider) {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  const service = new WorkbenchService(store,flomo,ai);
  const timestamp = '2026-10-13T00:00:00Z';
  const workspace = await store.createWorkspace({id:'ai-discovery',title:'生态位',memoId:'source',source:memo('source'),
    remote:null,sourceChanged:false,draft:'尚未发布的本地草稿',version:1,materials:[],messages:[],goal:'串联我的判断',
    analyses:[],createdAt:timestamp,updatedAt:timestamp,lastCheckedAt:timestamp},'web');
  t.after(async () => {await service.close();await store.close();});
  return {store,flomo,service,workspace};
}
function addResult(flomo: FakeFlomo, value = memo('a')) {
  flomo.memos.set(value.id,value);
  flomo.searchResults.set('生态位',[value]);
}

test('AI discovery searches planned terms, judges complete notes and atomically preserves the draft and user choices',async t => {
  const ai = new ScriptedAI([plan,ranking([
    recommendation('a','example'),recommendation('existing','counterpoint'),
  ])]);
  const f = await fixture(t,ai);
  for (const id of ['a','existing','picked','dismissed','weak']) f.flomo.memos.set(id,memo(id));
  f.flomo.searchResults.set('生态位',['a','existing','picked','dismissed','weak'].map(id => memo(id,{content:`搜索摘要 ${id}`,content_truncated:true})));
  f.flomo.searchResults.set('定位',[memo('a')]);
  const picked = memo('picked',{content:'用户已选用的旧快照'});
  const initial = await f.store.updateWorkspace(f.workspace.id,1,'web','materials',workspace => ({...workspace,
    materials:[picked],messages:[{id:'old-chat',role:'assistant',content:'旧聊天中的无依据推测',actor:'web',createdAt:''}],
    materialCandidates:[
      {memo:picked,reason:'用户已核对',relation:'support',status:'selected'},
      {memo:memo('dismissed'),reason:'用户暂时不用',relation:'background',status:'dismissed'},
      {memo:memo('existing'),reason:'仅关键词匹配',relation:'background',status:'proposed'},
    ],
  }));
  const result = await f.service.analysis.discoverWithAI(initial.id,input(initial),'web');
  assert.deepEqual(f.flomo.searches.map(search => search.query),['生态位','定位']);
  assert.deepEqual(new Set(f.flomo.getCalls),new Set(['a','existing','weak']));
  assert.equal(f.flomo.getCalls.length,3,'Already selected and dismissed candidates must not consume the read budget');
  assert.equal(ai.calls.length,2);
  assert.equal(ai.calls[0].workspace.draft,initial.draft);
  assert.equal(ai.calls[0].workspace.goal,initial.goal);
  assert.deepEqual(ai.calls[0].workspace.materials,[picked]);
  assert.deepEqual(ai.calls[0].workspace.messages,[]);
  assert.deepEqual(ai.calls[0].workspace.materialCandidates,[]);
  assert.deepEqual(ai.calls[0].workspace.analyses,[]);
  assert.deepEqual(ai.calls[0].workspace.noteDrafts,[]);
  assert.match(ai.calls[0].prompt,/寻找具体例子和反例/);
  const rankingContext = JSON.stringify(ai.calls[1]);
  assert.match(rankingContext,/完整正文 a/);
  assert.doesNotMatch(rankingContext,/搜索摘要|旧聊天中的无依据推测/);
  assert.equal(result.workspace.version,initial.version + 1,'Planning and collection must not create intermediate revisions');
  assert.equal(result.workspace.draft,initial.draft);
  assert.deepEqual(result.workspace.materials,[picked]);
  assert.deepEqual(result.workspace.messages,initial.messages);
  assert.equal(result.readCount,3);
  assert.equal(result.ai?.recommendedCount,2);
  const candidates = result.workspace.materialCandidates ?? [];
  assert.equal(candidates.find(item => item.memo.id === 'picked')?.status,'selected');
  assert.deepEqual(candidates.find(item => item.memo.id === 'picked')?.memo,picked);
  assert.equal(candidates.find(item => item.memo.id === 'dismissed')?.status,'dismissed');
  assert.equal(candidates.find(item => item.memo.id === 'existing')?.relation,'counterpoint');
  assert.match(candidates.find(item => item.memo.id === 'existing')?.reason ?? '',/全文提供/);
  assert.equal(candidates.find(item => item.memo.id === 'a')?.status,'proposed');
  assert.equal(candidates.find(item => item.memo.id === 'a')?.relation,'example');
  assert.equal(candidates.find(item => item.memo.id === 'a')?.memo.content,memo('a').content);
  assert.equal(candidates.some(item => item.memo.id === 'weak'),false);
});

test('AI discovery keeps filters and excludes unreadable, truncated or filtered notes before evaluation',async t => {
  const ai = new ScriptedAI([plan,ranking([recommendation('a')])]);
  const f = await fixture(t,ai);
  addResult(f.flomo);
  f.flomo.memos.set('truncated',memo('truncated',{content_truncated:true}));
  f.flomo.memos.set('empty',memo('empty',{content:' '}));
  f.flomo.memos.set('changed-tags',memo('changed-tags',{tags:['想法','概要']}));
  f.flomo.recommendations.set('a',[
    memo('missing'),memo('truncated'),memo('empty'),memo('changed-tags'),
    memo('excluded',{tags:['想法','概要']}),memo('old',{created_at:'2025-01-01'}),
  ]);
  const filters = {tag:'想法',excludeTag:'概要',startDate:'2026-01-01',endDate:'2026-12-31'};
  const result = await f.service.analysis.discoverWithAI(f.workspace.id,{...input(f.workspace),...filters},'mcp');
  for (const search of f.flomo.searches) {
    for (const [key,value] of Object.entries(filters)) assert.equal(search[key as keyof MemoSearch],value);
  }
  assert.deepEqual(result.workspace.materialCandidates?.map(candidate => candidate.memo.id),['a']);
  assert.equal(result.possiblyLimited,true);
  assert.deepEqual(new Set(result.omitted.map(item => item.memoId)),new Set(['missing','truncated','empty','changed-tags','excluded','old']));
  const rankingContext = JSON.stringify(ai.calls[1]);
  assert.match(rankingContext,/完整正文 a/);
  assert.doesNotMatch(rankingContext,/完整正文 (missing|truncated|changed-tags|excluded|old)/);
});

test('AI discovery rejects invalid model plans and rankings without persisting candidates',async t => {
  const cases: {name:string;replies:string[]}[] = [
    {name:'malformed plan',replies:['not JSON']},
    {name:'empty search plan',replies:[JSON.stringify({terms:[]})]},
    {name:'too many search terms',replies:[JSON.stringify({terms:Array.from({length:7},(_,index) => `term ${index}`)})]},
    {name:'malformed ranking',replies:[plan,'not JSON']},
    {name:'unknown memo ID',replies:[plan,ranking([recommendation('invented')])]},
    {name:'duplicate memo ID',replies:[plan,ranking([recommendation('a'),recommendation('a')])]},
    {name:'unsupported relation',replies:[plan,ranking([recommendation('a','automatically-selected')])]},
    {name:'empty reason',replies:[plan,ranking([{...recommendation('a'),reason:''}])]},
  ];
  for (const item of cases) await t.test(item.name,async t => {
    const f = await fixture(t,new ScriptedAI(item.replies));
    addResult(f.flomo);
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web'),{code:'AI_DISCOVERY_INVALID'});
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
  });
});

test('a failed ranking request does not leave search results partially saved',async t => {
  const ai = new ScriptedAI([plan,() => {throw new ProviderError('AI 服务暂时不可用','AI_UNAVAILABLE');}]);
  const f = await fixture(t,ai);
  addResult(f.flomo);
  await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web'),{code:'AI_UNAVAILABLE'});
  assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
});

test('AI discovery checks versions before AI and again after ranking without overwriting concurrent edits',async t => {
  const started = deferred(), gate = deferred();
  const ai = new ScriptedAI([plan,async () => {started.resolve();await gate.promise;return ranking([recommendation('a')]);}]);
  const f = await fixture(t,ai);
  t.after(() => gate.resolve());
  addResult(f.flomo);
  await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,{...input(f.workspace),baseVersion:2},'web'),{code:'VERSION_CONFLICT'});
  assert.equal(ai.calls.length,0);
  assert.equal(f.flomo.searches.length,0);
  const pending = f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web');
  const rejected = assert.rejects(pending,{code:'VERSION_CONFLICT'});
  await started.promise;
  try {
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace,'No search candidates may be saved while ranking is running');
    await f.store.updateWorkspace(f.workspace.id,1,'web','draft',workspace => ({...workspace,draft:'用户在等待时继续修改草稿'}));
  } finally {gate.resolve();}
  await rejected;
  const current = await f.store.getWorkspace(f.workspace.id);
  assert.equal(current.version,2);
  assert.equal(current.draft,'用户在等待时继续修改草稿');
  assert.deepEqual(current.materialCandidates,[]);
});

test('AI discovery validates dates before paying for AI requests',async t => {
  const ai = new ScriptedAI([]);
  const f = await fixture(t,ai);
  for (const dates of [{startDate:'2026-02-30'},{startDate:'2026-10-13',endDate:'2026-10-01'}]) {
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,{...input(f.workspace),...dates},'web'),{code:'INVALID_DATE_RANGE'});
  }
  assert.equal(ai.calls.length,0);
  assert.equal(f.flomo.searches.length,0);
  assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
});

test('AI discovery without an AI provider leaves the workspace untouched',async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web'),{code:'AI_NOT_CONFIGURED'});
  assert.equal(f.flomo.searches.length,0);
  assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
});

test('an empty search skips ranking and reports zero recommendations without a workspace revision',async t => {
  const ai = new ScriptedAI([plan]);
  const f = await fixture(t,ai);
  const result = await f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'cli');
  assert.equal(ai.calls.length,1);
  assert.equal(result.readCount,0);
  assert.equal(result.ai?.recommendedCount,0);
  assert.deepEqual(result.workspace,f.workspace);
});

test('AI discovery can use source-note recommendations when planned terms have no keyword matches',async t => {
  const ai = new ScriptedAI([plan,ranking([recommendation('related','background')])]);
  const f = await fixture(t,ai);
  f.flomo.memos.set('related',memo('related'));
  f.flomo.recommendations.set('source',[memo('source'),memo('related',{content:'相关笔记摘要',content_truncated:true})]);
  const result = await f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web');
  assert.deepEqual(f.flomo.relatedCalls,['source']);
  assert.deepEqual(f.flomo.getCalls,['related']);
  assert.equal(result.ai?.recommendedCount,1);
  assert.deepEqual(result.workspace.materialCandidates?.map(candidate => candidate.memo.id),['related']);
});

test('AI discovery shares its full-read budget across search angles and reports omitted candidates',async t => {
  const ai = new ScriptedAI([plan,ranking([recommendation('other-angle'),recommendation('first-angle')])]);
  const f = await fixture(t,ai);
  for (const id of ['first-angle','same-angle','other-angle']) f.flomo.memos.set(id,memo(id));
  f.flomo.searchResults.set('生态位',[memo('first-angle'),memo('same-angle')]);
  f.flomo.searchResults.set('定位',[memo('other-angle')]);
  const result = await f.service.analysis.discoverWithAI(f.workspace.id,{...input(f.workspace),limit:2},'web');
  assert.deepEqual(f.flomo.getCalls,['first-angle','other-angle']);
  assert.equal(result.readCount,2);
  assert.equal(result.ai?.recommendedCount,2);
  assert.equal(result.possiblyLimited,true);
  assert.ok(result.omitted.some(item => item.memoId === 'same-angle'));
  assert.deepEqual(result.workspace.materialCandidates?.map(candidate => candidate.memo.id),['other-angle','first-angle']);
});

test('AI may reject every fully read candidate without changing workspace state',async t => {
  const ai = new ScriptedAI([plan,ranking([])]);
  const f = await fixture(t,ai);
  addResult(f.flomo);
  const result = await f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web');
  assert.equal(ai.calls.length,2);
  assert.equal(result.readCount,1);
  assert.equal(result.ai?.recommendedCount,0);
  assert.deepEqual(result.workspace,f.workspace);
});

test('AI discovery rejects oversized input and output without saving partial results',async t => {
  await t.test('oversized planning context is rejected before calling AI',async t => {
    const ai = new ScriptedAI([]);
    const f = await fixture(t,ai);
    const initial = await f.store.updateWorkspace(f.workspace.id,1,'web','draft',workspace => ({...workspace,draft:'长'.repeat(120_001)}));
    await assert.rejects(f.service.analysis.discoverWithAI(initial.id,input(initial),'web'),{code:'AI_DISCOVERY_INPUT_LIMIT'});
    assert.equal(ai.calls.length,0);
    assert.equal(f.flomo.searches.length,0);
    assert.deepEqual(await f.store.getWorkspace(initial.id),initial);
  });
  await t.test('oversized candidate text is rejected before ranking rather than truncated',async t => {
    const ai = new ScriptedAI([plan]);
    const f = await fixture(t,ai);
    addResult(f.flomo,memo('a',{content:'完整材料'.repeat(30_001)}));
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web'),{code:'AI_DISCOVERY_INPUT_LIMIT'});
    assert.equal(ai.calls.length,1);
    assert.deepEqual(f.flomo.getCalls,['a']);
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
  });
  await t.test('oversized ranking output cannot leave the collected candidates saved',async t => {
    const ai = new ScriptedAI([plan,ranking([recommendation('a')]) + ' '.repeat(24_001)]);
    const f = await fixture(t,ai);
    addResult(f.flomo);
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web'),{code:'AI_DISCOVERY_INVALID'});
    assert.equal(ai.calls.length,2);
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
  });
});

test('AI discovery rejects a concurrent request immediately and releases its guard after completion',async t => {
  const started = deferred(), gate = deferred();
  const ai = new ScriptedAI([
    async () => {started.resolve();await gate.promise;return plan;},ranking([recommendation('a')]),
    plan,ranking([recommendation('a','example')]),
  ]);
  const f = await fixture(t,ai);
  addResult(f.flomo);
  const pending = f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'web');
  await started.promise;
  try {
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id,input(f.workspace),'cli'),{code:'AI_DISCOVERY_RUNNING'});
    assert.equal(ai.calls.length,1,'A concurrent request must not make its own model call or wait for the first request');
    assert.equal(f.flomo.searches.length,0);
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
  } finally {gate.resolve();}
  const first = await pending;
  const retried = await f.service.analysis.discoverWithAI(first.workspace.id,input(first.workspace),'cli');
  assert.equal(ai.calls.length,4);
  assert.equal(retried.workspace.version,first.workspace.version + 1);
  assert.equal(retried.workspace.materialCandidates?.length,1);
  assert.equal(retried.workspace.materialCandidates?.[0].relation,'example');
});

test('AI discovery stays within 100 candidates while allowing existing candidates to be recommended again',async t => {
  const recommended = ranking([recommendation('existing-0','counterpoint'),recommendation('fresh','example')]);
  const ai = new ScriptedAI([plan,recommended,plan,recommended]);
  const f = await fixture(t,ai);
  const initial = await f.store.updateWorkspace(f.workspace.id,1,'web','materials',workspace => ({...workspace,
    materialCandidates:Array.from({length:99},(_,index) => ({memo:memo(`existing-${index}`),
      reason:'之前的关键词候选',relation:'background' as const,status:'proposed' as const})),
  }));
  for (const id of ['fresh','overflow','existing-0']) f.flomo.memos.set(id,memo(id));
  f.flomo.searchResults.set('生态位',['fresh','overflow','existing-0'].map(id => memo(id)));
  const filled = await f.service.analysis.discoverWithAI(initial.id,input(initial),'web');
  assert.equal(filled.workspace.materialCandidates?.length,100);
  assert.equal(new Set(filled.workspace.materialCandidates?.map(candidate => candidate.memo.id)).size,100);
  assert.equal(filled.ai?.recommendedCount,2);
  assert.deepEqual(f.flomo.getCalls,['fresh','existing-0']);
  assert.ok(filled.omitted.some(item => item.memoId === 'overflow' && item.reason.includes('100')));
  assert.equal(filled.possiblyLimited,true);
  const full = await f.service.analysis.discoverWithAI(filled.workspace.id,input(filled.workspace),'web');
  assert.equal(full.workspace.materialCandidates?.length,100);
  assert.equal(full.ai?.recommendedCount,2,'The cap must allow reevaluation of candidates already in the workspace');
  assert.equal(full.workspace.materialCandidates?.[0].memo.id,'existing-0');
  assert.equal(full.workspace.materialCandidates?.[0].relation,'counterpoint');
  assert.equal(full.workspace.materialCandidates?.some(candidate => candidate.memo.id === 'overflow'),false);
  assert.deepEqual(new Set(full.workspace.materialCandidates?.map(candidate => candidate.memo.id)),new Set(filled.workspace.materialCandidates?.map(candidate => candidate.memo.id)));
  assert.deepEqual(full.workspace.materials,[]);
  assert.equal(full.workspace.draft,initial.draft);
});

test('AI discovery HTTP route validates actor and parameters, applies defaults and exposes version conflicts',async t => {
  const ai = new ScriptedAI([plan,ranking([recommendation('a','example')])]);
  const f = await fixture(t,ai);
  addResult(f.flomo);
  const app = await createApp({service:f.service});
  t.after(() => app.close());
  const url = `/api/v1/workspaces/${f.workspace.id}/discover/ai`;
  const request = (payload: Record<string,unknown>) => app.inject({method:'POST',url,headers:{'x-workbench-actor':'web'},payload});
  const unauthorized = await app.inject({method:'POST',url,payload:{baseVersion:1}});
  assert.equal(unauthorized.statusCode,403);
  for (const payload of [{instruction:'长'.repeat(2001),baseVersion:1},{limit:31,baseVersion:1},{terms:['manual'],baseVersion:1}]) {
    const invalid = await request(payload);
    assert.equal(invalid.statusCode,400,invalid.body);
  }
  assert.equal(ai.calls.length,0);
  const found = await request({baseVersion:1});
  assert.equal(found.statusCode,200,found.body);
  assert.equal(found.json().ai.recommendedCount,1);
  assert.equal(found.json().workspace.materials.length,0);
  assert.equal(found.json().workspace.materialCandidates[0].status,'proposed');
  assert.equal(f.flomo.searches[0].limit,20);
  const stale = await request({baseVersion:1});
  assert.equal(stale.statusCode,409,stale.body);
  assert.equal(stale.json().error.code,'VERSION_CONFLICT');
  assert.equal(ai.calls.length,2);
});
