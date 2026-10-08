import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AnalysisRecord, Memo, Workspace } from '../shared/contracts.js';
import { analysisSources } from '../shared/analysis.js';
import { formatNoteDraft } from '../shared/note-drafts.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';

const memo = (id: string, content = `原始内容 ${id}`): Memo => ({id,url:`https://v.flomoapp.com/mine/?memo_id=${id}`,content,tags:[],created_at:'2026-10-08',updated_at:'2026-10-08',content_truncated:false,linked_memos:[]});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise,resolve};
}
async function fixture(t: TestContext) {
  const store = await Store.open(':memory:');
  const memos = new Map([['source',memo('source')],['selected',memo('selected')]]);
  const creates: string[] = [];
  const gets: string[] = [];
  const started = deferred();
  let gate: ReturnType<typeof deferred> | undefined;
  let failure: 'timeout'|'stripped-links'|'changed-content'|'wrong-id'|'truncated'|undefined;
  const service = new WorkbenchService(store,{
    get:async id => {gets.push(id);return structuredClone(memos.get(id)!);},
    search:async () => ({memos:[],scope:'remote-search',limit:20,possiblyLimited:false,checkedAt:''}),
    tags:async () => ({tags:[],total:0,returned:0,truncated:false}),related:async () => [],
    update:async () => {throw new Error('Creating derived notes must never update an original');},
    create:async content => {
      creates.push(content);started.resolve();await gate?.promise;
      if (failure === 'timeout') throw new Error('remote outcome unknown');
      const result = {...memo(`new-${creates.length}`,content),linked_memos:[...content.matchAll(/memo_id=([^\s]+)/g)].map(match => match[1])};
      const readback = {...result};
      if (failure === 'stripped-links') readback.linked_memos = [];
      if (failure === 'changed-content') readback.content = '远端没有保存完整正文';
      if (failure === 'wrong-id') readback.id = 'different-memo';
      if (failure === 'truncated') readback.content_truncated = true;
      memos.set(result.id,readback);
      return result;
    },
  });
  const workspace = await service.createWorkspace('source',undefined,'web');
  const app = await createApp({service});
  t.after(async () => {gate?.resolve();await app.close();await store.close();});
  const request = (method: 'POST'|'PATCH'|'GET', path: string, body?: unknown) => app.inject({method,url:`/api/v1/workspaces/${workspace.id}${path}`,headers:{'x-workbench-actor':'web'},...(body === undefined ? {} : {payload:body as Record<string,unknown>})});
  return {store,service,workspace,app,request,memos,creates,gets,started,
    block:() => {gate=deferred();return gate;}, fail:(mode: typeof failure) => {failure=mode;}};
}
const input = (version = 1,key = 'new-draft') => ({title:'新的独立判断',content:'基于已有笔记产生的新想法。',baseVersion:version,idempotencyKey:key});

test('new-note draft routes preserve original draft, keep selected source snapshots, and reject stale updates', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.workspace.noteDrafts,[]);
  let state = await f.service.setMaterials(f.workspace.id,['selected'],1,'web');
  const response = await f.request('POST','/note-drafts',input(state.version));
  assert.equal(response.statusCode,201,response.body);state=response.json();
  const draft=state.noteDrafts![0];
  assert.equal(state.draft,f.workspace.draft);
  assert.deepEqual(draft.sources.map(source => source.id),['selected','source']);
  assert.equal(f.creates.length,0);
  state=await f.service.setMaterials(state.id,[],state.version,'web');
  state=await f.store.updateWorkspace(state.id,state.version,'web','rebased',current => ({...current,source:memo('source','新的原文')}));
  assert.equal(state.noteDrafts![0].sources.find(source => source.id === 'source')!.content,'原始内容 source');
  const stale=await f.request('PATCH',`/note-drafts/${draft.id}`,{title:'冲突',content:'过时编辑',baseVersion:state.version-1});
  assert.equal(stale.statusCode,409,stale.body);
  const updated=await f.request('PATCH',`/note-drafts/${draft.id}`,{title:'编辑后的判断',content:'新的正文',baseVersion:state.version});
  assert.equal(updated.statusCode,200,updated.body);state=updated.json();
  assert.equal(state.noteDrafts![0].title,'编辑后的判断');
  assert.equal(state.noteDrafts![0].content,'新的正文');
  assert.deepEqual(state.noteDrafts![0].sources,draft.sources);
  assert.equal(state.draft,f.workspace.draft);
  assert.deepEqual(await f.store.listDraftRevisions(state.id),[]);
  assert.equal((await f.request('PATCH',`/note-drafts/${draft.id}`,{title:'',content:'',sources:[],baseVersion:state.version})).statusCode,400);
  assert.equal((await f.request('PATCH','/note-drafts/missing',{title:'',content:'',baseVersion:state.version})).statusCode,404);
});

test('draft creation handles concurrent identical retries and rejects reused keys with different payloads', async t => {
  const f = await fixture(t);
  const results=await Promise.all([f.request('POST','/note-drafts',input()),f.request('POST','/note-drafts',input())]);
  assert.deepEqual(results.map(result => result.statusCode),[201,201]);
  const first:Workspace=results[0].json();
  assert.equal(first.noteDrafts![0].id,results[1].json().noteDrafts[0].id);
  assert.equal((await f.store.getWorkspace(first.id)).version,2);
  assert.equal((await f.request('POST','/note-drafts',{...input(),content:'不同请求'})).statusCode,409);
  assert.equal((await f.request('POST','/note-drafts',input(1,'another-key'))).statusCode,409);
  assert.equal((await f.request('POST','/note-drafts',input(2,'another-key'))).statusCode,201);
  assert.equal((await f.store.getWorkspace(first.id)).noteDrafts!.length,2);
});

test('explicit publication matches preview, independently verifies readback, and never duplicates during or after completion', async t => {
  const f = await fixture(t);
  let state=await f.service.noteDrafts.create(f.workspace.id,input(),'web');
  const draft=state.noteDrafts![0];
  const gate=f.block();
  const published=await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:state.version,idempotencyKey:'publish'});
  assert.equal(published.statusCode,202,published.body);state=published.json();
  assert.equal(state.noteDrafts![0].status,'publishing');await f.started.promise;
  const retry=await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:1,idempotencyKey:'new-key'});
  assert.equal(retry.statusCode,202,retry.body);assert.equal(f.creates.length,1);
  const edit=await f.request('PATCH',`/note-drafts/${draft.id}`,{title:'不能修改发送中的内容',content:'',baseVersion:state.version});
  assert.equal(edit.statusCode,409,edit.body);
  state=await f.store.updateWorkspace(state.id,state.version,'web','draft',current => ({...current,draft:'写原笔记可以继续'}));
  gate.resolve();await f.service.settle();state=await f.store.getWorkspace(state.id);
  assert.equal(state.draft,'写原笔记可以继续');
  assert.equal(state.noteDrafts![0].status,'published');
  assert.equal(state.noteDrafts![0].resultMemo!.content,formatNoteDraft(draft));
  assert.equal(f.creates[0],formatNoteDraft(draft));assert.ok(f.gets.includes('new-1'));
  assert.equal(f.memos.get('source')!.content,'原始内容 source');
  assert.equal((await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:1,idempotencyKey:'publish'})).statusCode,202);
  await f.service.settle();assert.equal(f.creates.length,1);
  state=await f.service.noteDrafts.create(state.id,input(state.version,'other-draft'),'web');
  const other=state.noteDrafts!.at(-1)!;
  assert.equal((await f.request('POST',`/note-drafts/${other.id}/publish`,{baseVersion:state.version,idempotencyKey:'publish'})).statusCode,409);
});

test('unknown create outcomes and mismatched readbacks remain uncertain and cannot be retried', async t => {
  for (const mode of ['timeout','stripped-links','changed-content','wrong-id','truncated'] as const) {
    await t.test(mode,async t => {
      const f = await fixture(t);f.fail(mode);
      let state=await f.service.noteDrafts.create(f.workspace.id,input(),'web');
      const draft=state.noteDrafts![0];
      await f.service.noteDrafts.publish(state.id,draft.id,{baseVersion:state.version,idempotencyKey:'publish'},'web');
      await f.service.settle();state=await f.store.getWorkspace(state.id);
      assert.equal(state.noteDrafts![0].status,'uncertain');assert.ok(state.noteDrafts![0].error);
      await f.service.noteDrafts.publish(state.id,draft.id,{baseVersion:state.version,idempotencyKey:'different'},'cli');
      await f.service.settle();assert.equal(f.creates.length,1);
      await assert.rejects(f.service.noteDrafts.update(state.id,draft.id,{title:'changed',content:'',baseVersion:state.version},'web'),{code:'NOTE_DRAFT_NOT_EDITABLE'});
    });
  }
});

test('completed analysis creates a draft with historical evidence and always keeps the root source', async t => {
  const f=await fixture(t);
  let state=await f.service.setMaterials(f.workspace.id,['selected'],1,'web');
  const historical=analysisSources(state);
  state=await f.store.updateWorkspace(state.id,state.version,'mcp','analysis',current => ({...current,materials:[],source:memo('source','后来更新的正文'),analyses:[{
    id:'analysis',kind:'outline',engine:'external',question:'',status:'succeeded',workspaceVersion:2,inputFingerprint:'',goal:'',sources:historical,
    instructions:'',output:'提纲',cards:[],createdAt:'',updatedAt:'',actor:'mcp',idempotencyKey:'analysis',requestHash:'',
  } satisfies AnalysisRecord]}));
  state=await f.service.noteDrafts.create(state.id,{...input(state.version),originAnalysisId:'analysis'},'web');
  assert.deepEqual(state.noteDrafts![0].sources,historical);
  assert.equal(state.noteDrafts![0].originAnalysisId,'analysis');
  state=await f.store.updateWorkspace(state.id,state.version,'web','analysis',current => ({...current,analyses:current.analyses!.map(record => ({...record,sources:record.sources.filter(source => source.id !== 'source')}))}));
  state=await f.service.noteDrafts.create(state.id,{...input(state.version,'second'),originAnalysisId:'analysis'},'web');
  assert.equal(state.noteDrafts![1].sources.find(source => source.id === 'source')!.content,'后来更新的正文');
  await assert.rejects(f.service.noteDrafts.create(state.id,{...input(state.version,'missing'),originAnalysisId:'missing'},'web'),{code:'NOT_FOUND'});
  state=await f.store.updateWorkspace(state.id,state.version,'web','analysis',current => ({...current,analyses:current.analyses!.map(record => ({...record,status:'prepared'}))}));
  await assert.rejects(f.service.noteDrafts.create(state.id,{...input(state.version,'pending'),originAnalysisId:'analysis'},'web'),{code:'ANALYSIS_NOT_COMPLETE'});
});

test('blank local drafts are allowed but publication validates content, size and optimistic version before remote creation', async t => {
  const f=await fixture(t);
  let response=await f.request('POST','/note-drafts',{baseVersion:1,idempotencyKey:'blank'});
  assert.equal(response.statusCode,201,response.body);let state:Workspace=response.json();const draft=state.noteDrafts![0];
  response=await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:1,idempotencyKey:'publish'});
  assert.equal(response.statusCode,409,response.body);
  response=await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:state.version,idempotencyKey:'publish'});
  assert.equal(response.statusCode,422,response.body);
  state=await f.service.noteDrafts.update(state.id,draft.id,{title:'长草稿',content:'长'.repeat(20_000),baseVersion:state.version},'web');
  response=await f.request('POST',`/note-drafts/${draft.id}/publish`,{baseVersion:state.version,idempotencyKey:'publish'});
  assert.equal(response.statusCode,422,response.body);assert.equal(f.creates.length,0);
  assert.equal((await f.request('POST','/note-drafts',{...input(state.version),title:'长'.repeat(201)})).statusCode,400);
  assert.equal((await f.request('POST','/note-drafts',{...input(state.version),content:'长'.repeat(100_001)})).statusCode,400);
  state=await f.store.updateWorkspace(state.id,state.version,'web','materials',current => ({...current,source:{...current.source,content_truncated:true}}));
  assert.equal((await f.request('POST','/note-drafts',input(state.version,'incomplete'))).statusCode,422);
});

test('recovery marks interrupted creation uncertain without writing remotely and hydrates old workspace data', async t => {
  const f=await fixture(t);
  const legacy={...f.workspace,id:'old-workspace'};delete legacy.noteDrafts;
  await f.store.createWorkspace(legacy,'web');
  assert.deepEqual((await f.store.getWorkspace(legacy.id)).noteDrafts,[]);
  let state=await f.service.noteDrafts.create(f.workspace.id,input(),'web');
  const draftId=state.noteDrafts![0].id;
  state=await f.store.updateWorkspace(state.id,state.version,'web','note-draft-publishing',current => ({...current,noteDrafts:current.noteDrafts!.map(draft => ({...draft,status:'publishing',publicationKey:'pending',publicationHash:'hash'}))}));
  await f.service.recover();state=await f.store.getWorkspace(state.id);
  assert.equal(state.noteDrafts![0].status,'uncertain');assert.match(state.noteDrafts![0].error!,/服务曾中断/);
  await f.service.noteDrafts.publish(state.id,draftId,{baseVersion:state.version,idempotencyKey:'retry'},'web');
  await f.service.settle();assert.equal(f.creates.length,0);assert.equal(state.draft,f.workspace.draft);
});

test('new-note preview preserves Markdown and source URLs while neutralizing source classification tags', () => {
  const sources=analysisSources({source:memo('source','#概要 旧分类'),materials:[]} as unknown as Workspace);
  const rendered=formatNoteDraft({title:'新想法',content:'**保留正文格式**\n\n#想法',sources});
  assert.match(rendered,/\*\*保留正文格式\*\*/);assert.match(rendered,/#想法/);assert.doesNotMatch(rendered,/#概要/);
  assert.match(rendered,/＃概要 旧分类/);assert.match(rendered,/memo_id=source/);
});
