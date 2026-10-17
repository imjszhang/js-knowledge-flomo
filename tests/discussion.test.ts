import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {CollectorArticle, Job, Memo, Workspace} from '../shared/contracts.js';
import {discussionContext, discussionContextStatus, discussionInput, discussionIsStale, discussionSources} from '../shared/discussion.js';
import {createApp} from '../server/app.js';
import {buildAIMessages} from '../server/providers.js';
import type {AIProvider, FlomoProvider} from '../server/provider-types.js';
import type {CollectorProvider} from '../server/collector.js';
import {WorkbenchService} from '../server/service.js';
import {Store} from '../server/store.js';

const memo = (id: string, content = `正文 ${id}`): Memo => ({id,content,url:`https://v.flomoapp.com/mine/?memo_id=${id}`,tags:['想法'],created_at:'2026-10-01',updated_at:'2026-10-01',content_truncated:false,linked_memos:[]});
const article: CollectorArticle = {id:'article',title:'收藏原文',sourceUrl:'https://example.test/article',content:'收藏正文',contentTruncated:false,summary:'摘要',digest:'概要',updatedAt:'2026-10-01'};
const workspace = (): Workspace => ({id:'w',memoId:'source',title:'工作区',source:memo('source'),remote:null,sourceChanged:false,draft:'本地草稿',goal:'理解材料',version:2,
  materials:[memo('selected')],collectorMaterials:[{kind:'collector',article:structuredClone(article),memoIds:['selected'],fetchedAt:'then'}],
  materialCandidates:[{memo:memo('selected'),status:'selected',relation:'support',reason:'已选理由'},{memo:memo('pending'),status:'proposed',relation:'background',reason:'待选理由'}],
  decisions:[{id:'d',question:'谁是读者',answer:'新手',options:['新手'],createdAt:'then',answeredAt:'then'}],
  messages:[],createdAt:'then',updatedAt:'then',lastCheckedAt:'then'});
function deferred() {let resolve!: () => void;const promise = new Promise<void>(done => {resolve=done;});return {promise,resolve};}

class FakeFlomo implements FlomoProvider {
  memos = new Map(['source','selected','pending'].map(id => [id,memo(id)]));
  reads: string[] = [];
  fail?: string;
  pause?: string;
  gate = deferred();
  started = deferred();
  async get(id: string) {
    this.reads.push(id);
    if (id === this.pause) {this.started.resolve();await this.gate.promise;}
    if (id === this.fail) throw new Error('provider unavailable');
    return structuredClone(this.memos.get(id)!);
  }
  async search() {return {memos:[],scope:'remote-search' as const,limit:30,possiblyLimited:false,checkedAt:''};}
  async related() {return [];}
  async tags() {return {tags:[],total:0,returned:0,truncated:false};}
  async update(): Promise<Memo> {throw new Error('This fixture must not write remotely');}
}
class FakeCollector implements CollectorProvider {
  article = structuredClone(article);
  fail = false;
  reads: string[] = [];
  async findByUrl() {return [];}
  async get(id: string) {this.reads.push(id);if(this.fail) throw new Error('collector unavailable');return structuredClone(this.article);}
}
async function fixture(t: TestContext, ai?: AIProvider) {
  const store=await Store.open(':memory:');const flomo=new FakeFlomo();const collector=new FakeCollector();
  const service=new WorkbenchService(store,flomo,ai,collector);
  const state=await store.createWorkspace(workspace(),'web');
  t.after(async()=>{flomo.gate.resolve();await service.close();await store.close();});
  return {store,flomo,collector,service,state};
}

test('discussion freshness tracks effective evidence and requirements, without treating routine timestamps as edits', () => {
  const state=workspace();const context=discussionContext(state);
  assert.equal(discussionContextStatus(undefined,state),'unknown');
  assert.equal(discussionIsStale(undefined,state),false);
  assert.equal(discussionContextStatus(context,state),'current');
  const edits: ((w: Workspace) => void)[] = [
    w=>{w.materials.push(memo('new'));},w=>{w.materials=[];},w=>{w.materials[0].content='新正文';},
    w=>{w.collectorMaterials![0].article.content='新收藏正文';},w=>{w.collectorMaterials=[];},
    w=>{w.goal='新目标';},w=>{w.draft='新草稿';},w=>{w.materialCandidates![0].reason='新理由';},
    w=>{w.materialCandidates![0].relation='counterpoint';},w=>{w.decisions![0].answer='专家';},
    w=>{w.remote=memo('source','已检查到的最新原文');},
  ];
  for (const edit of edits) {const next=structuredClone(state);edit(next);assert.equal(discussionContextStatus(context,next),'stale',edit.toString());}
  const unchanged=structuredClone(state);
  unchanged.version++;unchanged.updatedAt='now';unchanged.lastCheckedAt='now';unchanged.source.updated_at='now';
  unchanged.materials[0].updated_at='now';unchanged.collectorMaterials![0].fetchedAt='now';unchanged.collectorMaterials![0].article.updatedAt='now';
  unchanged.materialCandidates![1].reason='不同的待选理由';unchanged.messages.push({id:'m',role:'assistant',content:'后来回答',createdAt:'now',actor:'web'});
  assert.equal(discussionContextStatus(context,unchanged),'current');
});

test('current remote source and selected snapshots are adjacent to the current question after old conversation', () => {
  const state=workspace();state.remote=memo('source','#概要\n\n最新的主笔记');
  state.messages=[{id:'u',role:'user',content:'之前的问题',createdAt:'then',actor:'web'},
    {id:'a',role:'assistant',content:'目前没有材料，请粘贴 JSON',createdAt:'then',actor:'web'},
    {id:'u2',role:'user',content:'现在怎么看',createdAt:'now',actor:'web'}];
  const messages=buildAIMessages(state,'现在怎么看');
  assert.equal(messages.at(-1)!.content,'现在怎么看');
  assert.equal(messages.filter(item=>item.content === '现在怎么看').length,1);
  assert.equal(messages.at(-3)!.content,'目前没有材料，请粘贴 JSON');
  const data=JSON.parse(String(messages.at(-2)!.content).split('\n').slice(1).join('\n'));
  assert.deepEqual(data,discussionInput(state));assert.match(String(messages[0].content),/旧版本.*不代表当前状态/);
  assert.equal(data.materials.find((m: {id:string})=>m.id === 'source')!.content,state.remote.content);
  assert.equal(data.materials.some((m: {id:string})=>m.id === 'pending'),false);
  assert.equal(discussionSources(state).find(source=>source.id === 'source')!.title,'最新的主笔记');
});

test('AI records its starting context and stays stale when selected materials change during generation', async t => {
  const gate=deferred();const started=deferred();let received: Workspace | undefined;
  const f=await fixture(t,{async generate(state,_prompt,onChunk) {received=state;await onChunk('开始回答');started.resolve();await gate.promise;return '依照之前材料的回答';}});
  t.after(()=>gate.resolve());
  const job=await f.service.generate(f.state.id,'讨论问题',f.state.version,'ai-first','web');
  await started.promise;
  const pending=await f.store.getWorkspace(f.state.id);
  assert.deepEqual(pending.messages[0].discussionContext,job.discussionContext);
  const changed=await f.store.updateWorkspace(pending.id,pending.version,'cli','materials',w=>({...w,materials:[...w.materials,memo('new')]}));
  gate.resolve();await f.service.settle();
  const finished=await f.store.getWorkspace(f.state.id);
  assert.equal(received!.materials.length,1);assert.equal(finished.materials.length,2);
  assert.equal(discussionContextStatus(finished.messages.at(-1)!.discussionContext,finished),'stale');
  assert.deepEqual(finished.messages.at(-1)!.discussionContext,job.discussionContext);
  assert.deepEqual((await f.store.getJob(job.id)).discussionContext,job.discussionContext);
  assert.equal(finished.draft,changed.draft);
  const second=await f.service.generate(f.state.id,'根据新材料继续',finished.version,'ai-second','mcp');
  await f.service.settle();
  assert.equal(received!.materials.length,2);
  assert.equal(discussionContextStatus(second.discussionContext,await f.store.getWorkspace(f.state.id)),'current');
});

test('external and legacy discussion messages remain unknown rather than acquiring invented context', async t => {
  const f=await fixture(t);const app=await createApp({service:f.service});t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:`/api/v1/workspaces/${f.state.id}/messages`,headers:{'x-workbench-actor':'mcp'},payload:{role:'assistant',content:'外部回答',baseVersion:f.state.version}});
  assert.equal(response.statusCode,200,response.body);
  const state=response.json<Workspace>();assert.equal(discussionContextStatus(state.messages[0].discussionContext,state),'unknown');
});

test('explicit discussion refresh updates all selected sources atomically, while preserving draft and source baseline', async t => {
  const f=await fixture(t);f.flomo.memos.set('source',memo('source','远端新原文'));f.flomo.memos.set('selected',memo('selected','远端新材料'));
  f.collector.article.content='收藏新正文';
  const app=await createApp({service:f.service});t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:`/api/v1/workspaces/${f.state.id}/discussion/refresh`,headers:{'x-workbench-actor':'cli'},payload:{baseVersion:f.state.version}});
  assert.equal(response.statusCode,200,response.body);const updated=response.json<Workspace>();
  assert.deepEqual(updated.source,f.state.source);assert.equal(updated.draft,f.state.draft);
  assert.equal(updated.remote!.content,'远端新原文');assert.equal(updated.sourceChanged,true);
  assert.equal(updated.materials[0].content,'远端新材料');assert.equal(updated.materialCandidates![0].memo.content,'远端新材料');
  assert.equal(updated.collectorMaterials![0].article.content,'收藏新正文');
  assert.deepEqual(f.flomo.reads,['source','selected']);assert.deepEqual(f.collector.reads,['article']);
  assert.equal(discussionContextStatus(discussionContext(f.state),updated),'stale');
  assert.equal((await f.store.changes()).at(-1)!.actor,'cli');
  const invalid=await app.inject({method:'POST',url:`/api/v1/workspaces/${f.state.id}/discussion/refresh`,headers:{'x-workbench-actor':'cli'},payload:{baseVersion:updated.version,extra:true}});
  assert.equal(invalid.statusCode,400);
});

test('refresh rejects stale versions before reading any providers', async t => {
  const f=await fixture(t);
  await assert.rejects(f.service.refreshDiscussion(f.state.id,f.state.version-1,'mcp'),{code:'VERSION_CONFLICT'});
  assert.deepEqual(f.flomo.reads,[]);assert.deepEqual(f.collector.reads,[]);
});

test('refresh failures, partial content and incorrect identities keep every previous snapshot', async t => {
  const cases=['flomo failure','collector failure','flomo partial','collector partial','flomo identity','collector identity'];
  for (const scenario of cases) await t.test(scenario,async t=>{
    const f=await fixture(t);f.flomo.memos.set('source',memo('source','必须不提交的新正文'));
    if (scenario === 'flomo failure') f.flomo.fail='selected';
    if (scenario === 'collector failure') f.collector.fail=true;
    if (scenario === 'flomo partial') f.flomo.memos.get('selected')!.content_truncated=true;
    if (scenario === 'collector partial') f.collector.article.contentTruncated=true;
    if (scenario === 'flomo identity') f.flomo.memos.get('selected')!.id='wrong';
    if (scenario === 'collector identity') f.collector.article.id='wrong';
    const before=await f.store.getWorkspace(f.state.id);
    await assert.rejects(f.service.refreshDiscussion(f.state.id,f.state.version,'web'));
    assert.deepEqual(await f.store.getWorkspace(f.state.id),before);
  });
});

test('refresh never replaces a concurrent draft or material selection', async t => {
  const f=await fixture(t);f.flomo.pause='selected';
  const request=f.service.refreshDiscussion(f.state.id,f.state.version,'web');
  await f.flomo.started.promise;
  const changed=await f.store.updateWorkspace(f.state.id,f.state.version,'mcp','materials',w=>({...w,draft:'另一端草稿',materials:[]}));
  f.flomo.gate.resolve();
  await assert.rejects(request,{code:'VERSION_CONFLICT'});
  assert.deepEqual(await f.store.getWorkspace(f.state.id),changed);
});

test('discussion refresh respects pending remote writes', async t => {
  const f=await fixture(t);const job:Job={id:'pending-write',workspaceId:f.state.id,kind:'publish',status:'uncertain',actor:'web',text:'',error:null,createdAt:'now',updatedAt:'now',idempotencyKey:'once',baseVersion:f.state.version};
  await f.store.putJob(job);
  await assert.rejects(f.service.refreshDiscussion(f.state.id,f.state.version,'web'),{code:'PUBLISH_PENDING'});
  assert.deepEqual(f.flomo.reads,[]);
});
