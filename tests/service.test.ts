import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memo, Job } from '../shared/contracts.js';
import type { AIProvider, FlomoProvider } from '../server/provider-types.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class FakeFlomo implements FlomoProvider {
  memo: Memo = { id:'m1', url:'https://v.flomoapp.com/mine/?memo_id=m1', content:'原始想法 #待编/想法', tags:['待编/想法'],
    created_at:'2026-09-29T01:00:00Z',updated_at:'2026-09-29T01:00:00Z',content_truncated:false,linked_memos:[] };
  creates = 0;
  async create(content: string) {
    this.creates++;
    if (this.uncertain) throw new Error('network timeout after create');
    return {...this.memo, id:'new-note', content, linked_memos:['m1']};
  }
  writes = 0;
  uncertain = false;
  updateGate?: ReturnType<typeof deferred>;
  started = deferred();
  async get(id: string) { return structuredClone({...this.memo, id}); }
  async search() { return {memos:[await this.get('m1')],scope:'remote-search' as const,limit:30,possiblyLimited:false,checkedAt:new Date().toISOString()}; }
  async tags() { return {tags:['待编','待编/想法'],total:2,returned:2,truncated:false}; }
  async related() { return []; }
  async update(id: string, content: string, updatedAt?: string) {
    assert.equal(updatedAt, this.memo.updated_at);
    this.writes++; this.started.resolve();
    if (this.updateGate) await this.updateGate.promise;
    this.memo = {...this.memo,id,content,updated_at:'2026-09-29T02:00:00Z'};
    if (this.uncertain) throw new Error('network timeout after remote commit');
    return this.get(id);
  }
}
async function setup(ai?: AIProvider) {
  const store = await Store.open(':memory:');
  const flomo = new FakeFlomo();
  const service = new WorkbenchService(store,flomo,ai);
  const workspace = await service.createWorkspace('m1',undefined,'web');
  const close = async () => { await service.close(); await store.close(); };
  return {store,flomo,service,workspace,close};
}

test('parallel writers have one winner and preserve the losing draft in conflict details', async () => {
  const f = await setup();
  try {
    const update = (draft: string) => f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft}));
    const results = await Promise.allSettled([update('CLI draft'),update('Web draft')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code,'VERSION_CONFLICT');
    assert.equal(rejected.reason.details.current.draft,'CLI draft');
    const events = await f.store.changes(0);
    assert.deepEqual(events.map(e => e.kind),['created','draft']);
    assert.equal(events[1].version,2);
  } finally { await f.close(); }
});

test('a failed change observer cannot turn a durable save into a reported failure', async () => {
  const f = await setup();
  try {
    f.store.events.on('change', () => { throw new Error('socket closed'); });
    const saved = await f.store.updateWorkspace(f.workspace.id,1,'web','draft',w => ({...w,draft:'persisted'}));
    assert.equal(saved.draft,'persisted');
    assert.equal((await f.store.getWorkspace(saved.id)).version,2);
    assert.equal((await f.store.changes()).at(-1)?.kind,'draft');
  } finally { await f.close(); }
});

test('same publication key cannot write twice and a changed request cannot reuse it', async () => {
  const f = await setup();
  try {
    const draft = await f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft:'ready'}));
    const [first,retry] = await Promise.all([f.service.publish(draft.id,2,'p1','cli'),f.service.publish(draft.id,2,'p1','cli')]);
    assert.equal(first.id,retry.id);
    await f.service.settle();
    assert.equal(f.flomo.writes,1);
    assert.equal((await f.store.getJob(first.id)).status,'succeeded');
    const after = await f.service.publish(draft.id,2,'p1','cli');
    assert.equal(after.id,first.id);
    await assert.rejects(f.service.publish(draft.id,3,'p1','cli'),{code:'IDEMPOTENCY_CONFLICT'});
  } finally { await f.close(); }
});

test('remote edits block publication until explicitly rebased, and preserve the draft', async () => {
  const f = await setup();
  try {
    f.flomo.memo.content = 'changed in flomo';
    const job = await f.service.publish(f.workspace.id,1,'conflict','web');
    await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'failed');
    assert.equal(f.flomo.writes,0);
    const current = await f.store.getWorkspace(f.workspace.id);
    assert.equal(current.sourceChanged,true);
    assert.equal(current.draft,f.workspace.draft);
    assert.equal(current.remote?.content,'changed in flomo');
    const rebased = await f.service.rebase(current.id,current.version,'web');
    assert.equal(rebased.source.content,'changed in flomo');
    assert.equal(rebased.draft,f.workspace.draft);
  } finally { await f.close(); }
});

test('typing during a remote write is kept as a newer local draft', async () => {
  const f = await setup();
  try {
    f.flomo.updateGate = deferred();
    const job = await f.service.publish(f.workspace.id,1,'slow','web');
    await f.flomo.started.promise;
    await f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft:'newer local edit'}));
    f.flomo.updateGate.resolve();
    await f.service.settle();
    const current = await f.store.getWorkspace(f.workspace.id);
    assert.equal(current.draft,'newer local edit');
    assert.equal(current.source.content,f.workspace.draft);
    assert.equal((await f.store.getJob(job.id)).status,'succeeded');
  } finally { f.flomo.updateGate?.resolve(); await f.close(); }
});

test('ambiguous remote writes require reconciliation without a second update', async () => {
  const f = await setup();
  try {
    f.flomo.uncertain = true;
    const job = await f.service.publish(f.workspace.id,1,'uncertain','web');
    await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'uncertain');
    await assert.rejects(f.service.publish(f.workspace.id,1,'another','web'),{code:'PUBLISH_PENDING'});
    assert.equal((await f.service.reconcile(job.id)).status,'succeeded');
    assert.equal(f.flomo.writes,1);
  } finally { await f.close(); }
});

test('AI streams a persisted job and appends a message without replacing edited text', async () => {
  const gate = deferred(); const started = deferred();
  const f = await setup({async generate(_workspace,_prompt,onChunk) { await onChunk('suggestion'); started.resolve(); await gate.promise; return 'suggestion'; }});
  try {
    const job = await f.service.generate(f.workspace.id,'help me',1,'ai1','web');
    await started.promise;
    const current = await f.store.getWorkspace(f.workspace.id);
    await f.store.updateWorkspace(current.id,current.version,'cli','draft',w => ({...w,draft:'my thought'}));
    gate.resolve(); await f.service.settle();
    const finished = await f.store.getWorkspace(current.id);
    assert.equal(finished.draft,'my thought');
    assert.deepEqual(finished.messages.map(m => m.role),['user','assistant']);
    assert.equal((await f.store.getJob(job.id)).text,'suggestion');
    assert.equal((await f.store.getJob(job.id)).status,'succeeded');
  } finally { gate.resolve(); await f.close(); }
});

test('durable drafts, cursor and job recovery survive reopening the database', async () => {
  const dir = await mkdtemp(join(tmpdir(),'flomo-workbench-'));
  let store = await Store.open(join(dir,'cache.db'));
  try {
    let service = new WorkbenchService(store,new FakeFlomo());
    const workspace = await service.createWorkspace('m1',undefined,'cli');
    const now = new Date().toISOString();
    const job:Job = {id:'restart',workspaceId:workspace.id,kind:'publish',status:'running',actor:'cli',text:'',error:null,createdAt:now,updatedAt:now,idempotencyKey:'once',baseVersion:1};
    await store.putJob(job); const cursor = (await store.changes()).at(-1)!.id;
    await store.close(); store = await Store.open(join(dir,'cache.db'));
    service = new WorkbenchService(store,new FakeFlomo()); await service.recover();
    assert.equal((await store.getWorkspace(workspace.id)).draft,workspace.draft);
    assert.equal((await store.getJob('restart')).status,'uncertain');
    assert.equal((await store.changes(cursor))[0].kind,'uncertain');
  } finally { await store.close(); await rm(dir,{recursive:true,force:true}); }
});

test('HTTP validates mutations, blocks foreign websites and returns version conflicts consistently', async () => {
  const f = await setup(); const app = await createApp({service:f.service});
  try {
    const url = `/api/v1/workspaces/${f.workspace.id}/draft`;
    const foreign = await app.inject({method:'PATCH',url,headers:{origin:'https://evil.example','x-workbench-actor':'web'},payload:{draft:'bad',baseVersion:1}});
    assert.equal(foreign.statusCode,403);
    const missingActor = await app.inject({method:'PATCH',url,payload:{draft:'bad',baseVersion:1}});
    assert.equal(missingActor.statusCode,403);
    const invalid = await app.inject({method:'PATCH',url,headers:{'x-workbench-actor':'cli'},payload:{draft:'bad',baseVersion:0}});
    assert.equal(invalid.statusCode,400);
    const update = await app.inject({method:'PATCH',url,headers:{'x-workbench-actor':'cli'},payload:{draft:'good',baseVersion:1}});
    assert.equal(update.statusCode,200);
    const stale = await app.inject({method:'PATCH',url,headers:{'x-workbench-actor':'web'},payload:{draft:'stale',baseVersion:1}});
    assert.equal(stale.statusCode,409);
    assert.equal(stale.json().error.code,'VERSION_CONFLICT');
  } finally { await app.close(); await f.close(); }
});

test('SSE replays a durable cursor and delivers a subsequent CLI update', async () => {
  const f = await setup(); const app = await createApp({service:f.service});
  const controller = new AbortController();
  try {
    const address = await app.listen({host:'127.0.0.1',port:0});
    const response = await fetch(`${address}/api/v1/events?after=0`,{signal:controller.signal});
    assert.equal(response.status,200);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    while (!text.includes('event: ready')) { const chunk = await reader.read(); text += decoder.decode(chunk.value); }
    assert.match(text,/"kind":"created"/);
    await f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft:'from codex'}));
    while (!text.includes('"kind":"draft"')) { const chunk = await reader.read(); text += decoder.decode(chunk.value); }
    assert.match(text,/"actor":"cli"/);
    controller.abort();
  } finally { controller.abort(); await app.close(); await f.close(); }
});


test('annotation creates a linked note exactly once and preserves source and draft', async () => {
  const f = await setup();
  try {
    const [one,two] = await Promise.all([f.service.annotate(f.workspace.id,'我的判断 #想法','annotation-key','web'), f.service.annotate(f.workspace.id,'我的判断 #想法','annotation-key','cli')]);
    assert.equal(one.id,two.id);
    await f.service.settle();
    const job = await f.store.getJob(one.id);
    assert.equal(job.status,'succeeded');
    assert.equal(job.resultMemo?.content,'我的判断 #想法\n\n关联原笔记：https://v.flomoapp.com/mine/?memo_id=m1');
    assert.equal(f.flomo.creates,1);
    assert.equal(f.flomo.writes,0);
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id),f.workspace);
    await assert.rejects(f.service.annotate(f.workspace.id,'另一个内容','annotation-key','web'), {code:'IDEMPOTENCY_CONFLICT'});
  } finally {await f.close();}
});

test('uncertain annotation creation is not retried', async () => {
  const f = await setup();
  try {
    f.flomo.uncertain = true;
    const job = await f.service.annotate(f.workspace.id,'我的想法','uncertain-key','web');
    await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'uncertain');
    await f.service.annotate(f.workspace.id,'我的想法','uncertain-key','web');
    assert.equal(f.flomo.creates,1);
  } finally {await f.close();}
});
