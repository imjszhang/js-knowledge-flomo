import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import type { Memo, Workspace } from '../shared/contracts.js';
import type { FlomoProvider } from '../server/provider-types.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';
import { buildAIMessages } from '../server/providers.js';

const memo = (id: string): Memo => ({id,url:`https://example.com/${id}`,content:`Full content ${id}`,tags:['想法'],
  created_at:'2026-09-29',updated_at:'2026-09-29',content_truncated:false,linked_memos:[]});
const provider: FlomoProvider = {
  get:async id => memo(id),search:async () => ({memos:[],scope:'remote-search',limit:30,possiblyLimited:false,checkedAt:new Date().toISOString()}),
  related:async () => [],tags:async () => ({tags:[],total:0,returned:0,truncated:false}),
  update:async () => { throw new Error('No real or fake remote writes permitted'); },
};
async function setup() {
  const store = await Store.open(':memory:');
  const service = new WorkbenchService(store,provider);
  const workspace = await service.createWorkspace('source',undefined,'cli');
  const app = await createApp({service});
  return {store,service,workspace,app,close:async () => {await app.close();await store.close();}};
}
async function rawSql(filename: string, sql: string, params?: unknown[]) {
  const db = await new Promise<sqlite3.Database>((resolve,reject) => {
    const handle = new sqlite3.Database(filename,error => error ? reject(error) : resolve(handle));
  });
  try {
    if (params) await new Promise<void>((resolve,reject) => db.run(sql,params,error => error ? reject(error) : resolve()));
    else await new Promise<void>((resolve,reject) => db.exec(sql,error => error ? reject(error) : resolve()));
  } finally {await new Promise<void>((resolve,reject) => db.close(error => error ? reject(error) : resolve()));}
}

test('legacy workspaces hydrate workflow defaults without losing draft, materials or unknown fields', async () => {
  const dir = await mkdtemp(join(tmpdir(),'flomo-workflow-'));
  const file = join(dir,'cache.db');
  let store: Store | undefined;
  try {
    await rawSql(file,'CREATE TABLE workbench_workspaces(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)');
    const legacy = {id:'legacy',title:'Existing',memoId:'source',source:memo('source'),remote:null,sourceChanged:false,
      draft:'Never overwrite my work',version:4,materials:[memo('material')],messages:[],createdAt:'then',updatedAt:'now',lastCheckedAt:'then',customLegacyField:'retained'};
    await rawSql(file,'INSERT INTO workbench_workspaces VALUES(?,?,?)',['legacy',4,JSON.stringify(legacy)]);
    store = await Store.open(file);
    const workspace = await store.getWorkspace('legacy');
    assert.equal(workspace.goal,'');assert.deepEqual(workspace.materialCandidates,[]);assert.deepEqual(workspace.decisions,[]);
    assert.equal(workspace.draft,legacy.draft);assert.deepEqual(workspace.materials,legacy.materials);
    assert.equal((workspace as Workspace & {customLegacyField:string}).customLegacyField,'retained');
    assert.deepEqual(await store.listDraftRevisions('legacy'),[]);
    await store.updateWorkspace('legacy',4,'web','goal',value => ({...value,goal:'New goal'}));
    await store.close();store = await Store.open(file);
    assert.equal((await store.getWorkspace('legacy')).draft,legacy.draft);
    assert.equal((await store.getWorkspace('legacy')).goal,'New goal');
  } finally {await store?.close();await rm(dir,{recursive:true,force:true});}
});

test('active context persists across restart, hydrates current data and rejects stale or invalid switches', async () => {
  const dir = await mkdtemp(join(tmpdir(),'flomo-context-'));const file = join(dir,'cache.db');
  let store = await Store.open(file);
  try {
    const service = new WorkbenchService(store,provider);const workspace = await service.createWorkspace('source',undefined,'web');
    assert.equal((await store.getContext()).revision,0);
    await store.setContext({workspaceId:workspace.id,view:'materials',baseRevision:0},'web');
    await store.updateWorkspace(workspace.id,1,'cli','goal',value => ({...value,goal:'Sharpen the audience'}));
    await assert.rejects(store.setContext({workspaceId:null,view:'note',baseRevision:0},'cli'),{code:'CONTEXT_CONFLICT'});
    await assert.rejects(store.setContext({workspaceId:'missing',view:'note',baseRevision:1},'cli'),{code:'NOT_FOUND'});
    await store.close();store = await Store.open(file);
    const current = await store.getContext();
    assert.equal(current.workspaceId,workspace.id);assert.equal(current.view,'materials');assert.equal(current.revision,1);
    assert.equal(current.workspace?.goal,'Sharpen the audience');
    assert.equal((await store.changes()).filter(change => change.entity === 'context').length,1);
  } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});

test('candidate recommendations, choices and traditional material replacement share one versioned state', async () => {
  const f = await setup();const url = `/api/v1/workspaces/${f.workspace.id}`;
  try {
    const proposed = await f.app.inject({method:'POST',url:`${url}/candidates`,headers:{'x-workbench-actor':'cli'},payload:{baseVersion:1,items:[
      {memoId:'m2',reason:'A real example',relation:'example'},{memoId:'m3',reason:'A different position',relation:'counterpoint'}]}});
    assert.equal(proposed.statusCode,200);
    assert.equal(proposed.json().materialCandidates[0].memo.content,'Full content m2');
    const selected = await f.app.inject({method:'PATCH',url:`${url}/candidates/m2`,headers:{'x-workbench-actor':'web'},payload:{status:'selected',baseVersion:2}});
    assert.equal(selected.statusCode,200);assert.deepEqual(selected.json().materials.map((m:Memo) => m.id),['m2']);
    const dismissed = await f.service.chooseCandidate(f.workspace.id,'m3','dismissed',3,'web');
    const reproposed = await f.service.proposeCandidates(f.workspace.id,[{memoId:'m2',reason:'More precise reason',relation:'support'},{memoId:'m3',reason:'Updated but rejected',relation:'background'}],dismissed.version,'cli');
    assert.deepEqual(reproposed.materialCandidates?.map(candidate => candidate.status),['selected','dismissed']);
    const replaced = await f.service.setMaterials(f.workspace.id,['m3'],reproposed.version,'cli');
    assert.deepEqual(replaced.materialCandidates?.map(candidate => candidate.status),['dismissed','selected']);
    assert.equal(replaced.materialCandidates?.[1].reason,'Updated but rejected');
    const back = await f.service.chooseCandidate(f.workspace.id,'m3','proposed',replaced.version,'web');
    assert.deepEqual(back.materials,[]);
    const read = (await f.app.inject(`${url}`)).json();
    assert.equal(read.version,back.version);assert.equal(read.materialCandidates[1].status,'proposed');
    const stale = await f.app.inject({method:'PATCH',url:`${url}/candidates/m2`,headers:{'x-workbench-actor':'cli'},payload:{status:'selected',baseVersion:2}});
    assert.equal(stale.statusCode,409);
    assert.equal((await f.store.changes()).at(-1)?.summary,'将一条材料放回候选列表');
  } finally {await f.close();}
});

test('material and proposal caps are atomic and source memo is never an extra material', async () => {
  const f = await setup();
  try {
    let current = await f.service.proposeCandidates(f.workspace.id,[{memoId:'source',reason:'Self',relation:'background'}],1,'cli');
    assert.deepEqual(current.materialCandidates,[]);
    current = await f.service.setMaterials(current.id,Array.from({length:30},(_,i) => `m${i}`),current.version,'cli');
    current = await f.service.proposeCandidates(current.id,[{memoId:'extra',reason:'Extra',relation:'example'}],current.version,'cli');
    await assert.rejects(f.service.chooseCandidate(current.id,'extra','selected',current.version,'web'),{code:'MATERIAL_LIMIT'});
    assert.equal((await f.store.getWorkspace(current.id)).version,current.version);
    for (const count of [30,30,9]) {
      const start = current.materialCandidates!.length;
      current = await f.service.proposeCandidates(current.id,Array.from({length:count},(_,i) => ({memoId:`proposal${start+i}`,reason:'Relevant',relation:'support' as const})),current.version,'cli');
    }
    assert.equal(current.materialCandidates?.length,100);
    await assert.rejects(f.service.proposeCandidates(current.id,[{memoId:'overflow',reason:'Over cap',relation:'support'}],current.version,'cli'),{code:'CANDIDATE_LIMIT'});
    await assert.rejects(f.service.setMaterials(current.id,Array.from({length:31},(_,i) => `n${i}`),current.version,'cli'),{code:'MATERIAL_LIMIT'});
    assert.equal((await f.store.getWorkspace(current.id)).version,current.version);
  } finally {await f.close();}
});

test('goals and decisions are versioned, allow a freeform answer and are shared through current context', async () => {
  const f = await setup();const url = `/api/v1/workspaces/${f.workspace.id}`;
  try {
    const goal = await f.app.inject({method:'PATCH',url:`${url}/goal`,headers:{'x-workbench-actor':'cli'},payload:{goal:'Choose a useful audience',baseVersion:1}});
    assert.equal(goal.statusCode,200);
    const decision = await f.app.inject({method:'POST',url:`${url}/decisions`,headers:{'x-workbench-actor':'cli'},payload:{question:'Who benefits?',options:['Researchers','Students'],baseVersion:2}});
    assert.equal(decision.statusCode,200);const question = decision.json().decisions[0];
    assert.equal(question.answer,null);
    const answer = await f.app.inject({method:'PATCH',url:`${url}/decisions/${question.id}`,headers:{'x-workbench-actor':'web'},payload:{answer:'Graduate students who cannot code',baseVersion:3}});
    assert.equal(answer.statusCode,200);assert.equal(answer.json().decisions[0].answer,'Graduate students who cannot code');
    const invalid = await f.app.inject({method:'PATCH',url:`${url}/decisions/missing`,headers:{'x-workbench-actor':'web'},payload:{answer:'Any',baseVersion:4}});
    assert.equal(invalid.statusCode,404);assert.equal((await f.store.getWorkspace(f.workspace.id)).version,4);
    await f.app.inject({method:'PUT',url:'/api/v1/context',headers:{'x-workbench-actor':'web'},payload:{workspaceId:f.workspace.id,view:'note',baseRevision:0}});
    const context = (await f.app.inject('/api/v1/context')).json();
    assert.equal(context.workspace.goal,'Choose a useful audience');assert.equal(context.workspace.decisions[0].answer,'Graduate students who cannot code');
  } finally {await f.close();}
});

test('draft revisions describe actual text changes, persist provenance and skip metadata/no-op text changes', async () => {
  const f = await setup();const url = `/api/v1/workspaces/${f.workspace.id}`;
  try {
    const updated = await f.app.inject({method:'PATCH',url:`${url}/draft`,headers:{'x-workbench-actor':'cli'},payload:{draft:'New draft',summary:'明确了读者并补充了两个例子',baseVersion:1}});
    assert.equal(updated.statusCode,200);
    await f.store.updateWorkspace(f.workspace.id,2,'web','goal',w => ({...w,goal:'New goal'}));
    await f.store.updateWorkspace(f.workspace.id,3,'web','draft',w => ({...w,draft:w.draft}));
    const history = (await f.app.inject(`${url}/revisions`)).json();
    assert.equal(history.length,1);assert.equal(history[0].before,f.workspace.draft);assert.equal(history[0].after,'New draft');
    assert.equal(history[0].fromVersion,1);assert.equal(history[0].toVersion,2);assert.equal(history[0].actor,'cli');
    assert.equal(history[0].summary,'明确了读者并补充了两个例子');
    await assert.rejects(f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft:'Stale'})),{code:'VERSION_CONFLICT'});
    assert.equal((await f.store.listDraftRevisions(f.workspace.id)).length,1);
  } finally {await f.close();}
});

test('draft, history and event commit or roll back together', async () => {
  const dir = await mkdtemp(join(tmpdir(),'flomo-revision-'));const file = join(dir,'cache.db');
  let store = await Store.open(file);
  try {
    const service = new WorkbenchService(store,provider);const workspace = await service.createWorkspace('source',undefined,'web');
    await rawSql(file,"CREATE TRIGGER reject_revision BEFORE INSERT ON workbench_draft_revisions BEGIN SELECT RAISE(ABORT, 'history unavailable'); END");
    await assert.rejects(store.updateWorkspace(workspace.id,1,'cli','draft',w => ({...w,draft:'Must roll back'})),/history unavailable/);
    assert.equal((await store.getWorkspace(workspace.id)).draft,workspace.draft);
    assert.equal((await store.getWorkspace(workspace.id)).version,1);assert.equal((await store.changes()).length,1);
    await rawSql(file,'DROP TRIGGER reject_revision');
    await store.updateWorkspace(workspace.id,1,'cli','draft',w => ({...w,draft:'Durable result'}));
    await store.close();store = await Store.open(file);
    assert.equal((await store.listDraftRevisions(workspace.id))[0].after,'Durable result');
    assert.equal((await store.changes()).at(-1)?.version,2);
  } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});

test('AI receives goal, selected evidence reasons and answered decisions, excluding rejected and pending candidates', async () => {
  const f = await setup();
  try {
    const workspace: Workspace = {...f.workspace,goal:'Define the audience',materials:[memo('chosen')],materialCandidates:[
      {memo:memo('chosen'),status:'selected',reason:'Relevant evidence',relation:'example'},
      {memo:memo('pending'),status:'proposed',reason:'Never selected',relation:'support'},
      {memo:memo('rejected'),status:'dismissed',reason:'Explicitly rejected',relation:'counterpoint'}],
      decisions:[{id:'d1',question:'Audience?',options:[],answer:'New graduate students',createdAt:'now',answeredAt:'now'},
        {id:'d2',question:'Open question',options:[],answer:null,createdAt:'now',answeredAt:null}]};
    const messages = buildAIMessages(workspace,'Continue');const context = String(messages[1].content);
    assert.match(context,/Define the audience/);assert.match(context,/Relevant evidence/);assert.match(context,/New graduate students/);
    assert.doesNotMatch(context,/Never selected|Explicitly rejected|Full content pending|Full content rejected|Open question/);
  } finally {await f.close();}
});
