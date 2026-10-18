import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, Memo } from '../shared/contracts.js';
import { noteLinkInputSchema } from '../shared/note-links.js';
import type { FlomoProvider } from '../server/provider-types.js';
import { memoLinksTo } from '../server/note-links.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';

const deferred = () => {
  let resolve!:() => void;
  return {promise:new Promise<void>(done => { resolve = done; }),resolve:() => resolve()};
};
const memo = (id:string, content = `原文 ${id}\n\n#想法`) : Memo => ({id,content,url:`https://v.flomoapp.com/mine/?memo_id=${id}`,
  tags:['想法'],created_at:'2026-10-13T00:00:00Z',updated_at:'2026-10-13T00:00:00Z',content_truncated:false,linked_memos:[]});
class FakeFlomo implements FlomoProvider {
  memos = new Map(['m1','m2','m3'].map(id => [id,memo(id)]));
  writes:string[] = [];
  gate?:ReturnType<typeof deferred>;
  started = deferred();
  failId?:string;
  timeoutId?:string;
  afterWrite?:(id:string) => void;
  async get(id:string) { const value = this.memos.get(id); if (!value) throw new Error('missing memo'); return structuredClone(value); }
  async search() { return {memos:[...this.memos.values()],scope:'remote-search' as const,limit:30,possiblyLimited:false,checkedAt:new Date().toISOString()}; }
  async tags() { return {tags:[],total:0,returned:0,truncated:false}; }
  async related() { return []; }
  async update(id:string, content:string, expectedUpdatedAt?:string, expectedContent?:string) {
    assert.equal(expectedContent,this.memos.get(id)!.content);
    assert.equal(expectedUpdatedAt,this.memos.get(id)!.updated_at);
    this.writes.push(id); this.started.resolve();
    if (this.gate) await this.gate.promise;
    if (id === this.failId) throw new Error('update rejected');
    this.memos.set(id,{...this.memos.get(id)!,content,linked_memos:[...content.matchAll(/https:\/\/v.flomoapp.com\/mine\/\?memo_id=([A-Za-z0-9_-]+)/g)].map(match => match[1]),updated_at:`2026-10-14T00:00:0${this.writes.length}Z`});
    this.afterWrite?.(id);
    if (id === this.timeoutId) throw new Error('timeout after remote commit');
    return this.get(id);
  }
}
async function setup() {
  const store = await Store.open(':memory:'); const flomo = new FakeFlomo();
  const service = new WorkbenchService(store,flomo); const workspace = await service.createWorkspace('m1',undefined,'web');
  const input = (extra:Record<string,unknown> = {}) => noteLinkInputSchema.parse({targetMemoId:'m2',baseVersion:workspace.version,...extra});
  const preview = (extra:Record<string,unknown> = {}) => service.noteLinks.preview(workspace.id,input(extra));
  const create = async (extra:Record<string,unknown> = {}, key = 'once') => {
    const result = await preview(extra);
    return service.noteLinks.create(workspace.id,{...result.input,previewHash:result.previewHash,idempotencyKey:key},'cli');
  };
  return {store,flomo,service,workspace,input,preview,create,close:async () => { flomo.gate?.resolve(); await service.close(); await store.close(); }};
}

test('link preview reads both complete notes, preserves exact existing text, and does not write', async () => {
  const f = await setup();
  try {
    f.flomo.memos.get('m1')!.content = '  原有文字\n\n';
    const result = await f.preview({direction:'bidirectional',relation:'support',reason:'补足依据'});
    assert.equal(result.steps.length,2);
    assert.equal(result.sourceMemo.content,'  原有文字\n\n');
    assert.ok(result.steps[0].afterContent.startsWith(result.sourceMemo.content));
    assert.match(result.steps[0].afterContent,/关联笔记（支持）：https:\/\/v.flomoapp.com\/mine\/\?memo_id=m2\n关联理由：补足依据$/);
    assert.match(result.steps[1].afterContent,/原笔记将本笔记用作支持/);
    assert.equal(result.previewHash.length,64);
    assert.deepEqual(f.flomo.writes,[]);
    assert.equal((await f.store.listJobs()).length,0);
    assert.equal((await f.store.getWorkspace(f.workspace.id)).version,1);
  } finally { await f.close(); }
});

test('links only count canonical URLs or confirmed linked memo IDs', () => {
  assert.equal(memoLinksTo({...memo('m1'),linked_memos:['m2']},'m2'),true);
  assert.equal(memoLinksTo(memo('m1',String.raw`原笔记：https://v.flomoapp.com/mine/?memo\_id=m2`),'m2'),true);
  assert.equal(memoLinksTo(memo('m1','[来源](https://v.flomoapp.com/mine/?memo_id=m2)'),'m2'),true);
  for (const text of ['m2','https://example.org/mine/?memo_id=m2','https://v.flomoapp.com.evil.org/mine/?memo_id=m2','https://v.flomoapp.com/mine/?memo_id=m23'])
    assert.equal(memoLinksTo(memo('m1',text),'m2'),false);
});

test('self links, incomplete notes, wrong identities, and oversized additions are rejected before mutation', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.preview({targetMemoId:'m1'}),{code:'SELF_LINK'});
    f.flomo.memos.get('m2')!.content_truncated = true;
    await assert.rejects(f.preview(),{code:'MEMO_CONTENT_UNAVAILABLE'});
    f.flomo.memos.set('m2',{...memo('m2'),id:'wrong'});
    await assert.rejects(f.preview(),{code:'MEMO_IDENTITY_MISMATCH'});
    f.flomo.memos.set('m2',memo('m2',''));
    await assert.rejects(f.preview(),{code:'MEMO_CONTENT_UNAVAILABLE'});
    f.flomo.memos.set('m2',memo('m2','a'.repeat(500_000)));
    await assert.rejects(f.preview({direction:'bidirectional'}),{code:'MEMO_TOO_LONG'});
    assert.equal(f.flomo.writes.length,0);
  } finally { await f.close(); }
});

test('already linked notes produce successful no-op jobs without changing the reason or content', async () => {
  const f = await setup();
  try {
    const before = '文字\nhttps://v.flomoapp.com/mine/?memo_id=m2';
    f.flomo.memos.get('m1')!.content = before;
    f.flomo.memos.get('m1')!.linked_memos = ['m2'];
    const job = await f.create({reason:'新的说明'}); await f.service.settle();
    const result = await f.store.getJob(job.id);
    assert.equal(result.status,'succeeded');
    assert.equal(result.link?.steps[0].alreadyLinked,true);
    assert.equal(f.flomo.writes.length,0);
    assert.equal(f.flomo.memos.get('m1')!.content,before);
  } finally { await f.close(); }
});

test('bidirectional linking syncs all workspaces while preserving drafts and source baselines', async () => {
  const f = await setup();
  try {
    const target = await f.service.createWorkspace('m2',undefined,'web');
    const secondSource = await f.service.createWorkspace('m1','another session','web');
    await f.store.updateWorkspace(target.id,target.version,'web','draft',w => ({...w,draft:'目标本地草稿'}));
    const selected = await f.service.setMaterials(f.workspace.id,['m2'],1,'web');
    const job = await f.create({direction:'bidirectional',baseVersion:selected.version}); await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'succeeded');
    assert.deepEqual(f.flomo.writes,['m1','m2']);
    for (const workspace of [f.workspace,target,secondSource]) {
      const current = await f.store.getWorkspace(workspace.id);
      assert.equal(current.source.content,workspace.source.content);
      assert.equal(current.sourceChanged,true);
      assert.equal(current.draft,workspace.id === target.id ? '目标本地草稿' : workspace.draft);
      assert.match(current.remote!.content,/memo_id=/);
      assert.equal((await f.service.noteLinks.list(workspace.id))[0].id,job.id);
    }
    const current = await f.store.getWorkspace(f.workspace.id);
    assert.match(current.materials[0].content,/memo_id=m1/);
    assert.match(current.materialCandidates![0].memo.content,/memo_id=m1/);
    const publication = await f.service.publish(current.id,current.version,'must-not-erase-link','web'); await f.service.settle();
    assert.equal((await f.store.getJob(publication.id)).status,'failed');
    assert.equal(f.flomo.writes.length,2);
    assert.ok((await f.store.changes()).some(change => change.kind === 'note-link'));
  } finally { await f.close(); }
});

test('a textual link without provider confirmation is never duplicated or reported as verified', async () => {
  const f = await setup();
  try {
    f.flomo.memos.get('m1')!.content = '链接示例：\nhttps://v.flomoapp.com/mine/?memo_id=m2';
    const job = await f.create(); await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'uncertain');
    assert.equal((await f.service.reconcile(job.id)).status,'uncertain');
    assert.equal(f.flomo.writes.length,0);
    f.flomo.memos.get('m1')!.linked_memos = ['m2'];
    assert.equal((await f.service.reconcile(job.id)).status,'succeeded');
    assert.equal(f.flomo.writes.length,0);
  } finally { await f.close(); }
});

test('readback must confirm the actual flomo relation in addition to matching content', async () => {
  const f = await setup();
  try {
    f.flomo.afterWrite = id => { f.flomo.memos.get(id)!.linked_memos = []; };
    const job = await f.create(); await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'uncertain');
    assert.equal((await f.service.reconcile(job.id)).status,'uncertain');
    assert.equal(f.flomo.writes.length,1);
  } finally { await f.close(); }
});

test('a local synchronization error preserves verified remote steps and reconciliation repairs snapshots', async () => {
  const f = await setup();
  const updateWorkspace = f.store.updateWorkspace.bind(f.store);
  try {
    f.store.updateWorkspace = async () => { throw new Error('temporary local save failure'); };
    const job = await f.create(); await f.service.settle();
    const failed = await f.store.getJob(job.id);
    assert.equal(failed.status,'uncertain');
    assert.equal(failed.link!.steps[0].status,'verified');
    assert.equal(f.flomo.writes.length,1);
    f.store.updateWorkspace = updateWorkspace;
    assert.equal((await f.service.reconcile(job.id)).status,'succeeded');
    assert.equal((await f.store.getWorkspace(f.workspace.id)).sourceChanged,true);
    assert.equal(f.flomo.writes.length,1);
  } finally { f.store.updateWorkspace = updateWorkspace; await f.close(); }
});

test('idempotent retries return the original job after workspace changes and reject changed instructions', async () => {
  const f = await setup();
  try {
    const preview = await f.preview();
    const input = {...preview.input,previewHash:preview.previewHash,idempotencyKey:'retry'};
    const [first,second] = await Promise.all([f.service.noteLinks.create(f.workspace.id,input,'mcp'),f.service.noteLinks.create(f.workspace.id,input,'mcp')]);
    assert.equal(first.id,second.id); await f.service.settle();
    assert.equal((await f.service.noteLinks.create(f.workspace.id,input,'mcp')).id,first.id);
    assert.equal(f.flomo.writes.length,1);
    await assert.rejects(f.service.noteLinks.create(f.workspace.id,{...input,reason:'changed'},'mcp'),{code:'IDEMPOTENCY_CONFLICT'});
  } finally { await f.close(); }
});

test('reconcile synchronization failure never duplicates steps and a later read-only reconcile repairs it', async () => {
  const f = await setup();
  const updateWorkspace = f.store.updateWorkspace.bind(f.store);
  try {
    f.flomo.timeoutId = 'm2';
    const job = await f.create({direction:'bidirectional'}); await f.service.settle();
    f.store.updateWorkspace = async () => { throw new Error('temporary local save failure'); };
    const incomplete = await f.service.reconcile(job.id);
    assert.equal(incomplete.status,'uncertain');
    assert.deepEqual(incomplete.link!.steps.map(step => step.memoId),['m1','m2']);
    assert.deepEqual(incomplete.link!.steps.map(step => step.status),['verified','verified']);
    assert.match(incomplete.link!.steps[0].error!,/同步本地记录失败/);
    assert.deepEqual((await f.store.getJob(job.id)).link!.steps.map(step => step.memoId),['m1','m2']);
    f.store.updateWorkspace = updateWorkspace;
    const repaired = await f.service.reconcile(job.id);
    assert.equal(repaired.status,'succeeded');
    assert.deepEqual(repaired.link!.steps.map(step => step.memoId),['m1','m2']);
    assert.equal(f.flomo.writes.length,2);
  } finally { f.store.updateWorkspace = updateWorkspace; await f.close(); }
});

test('changes to preview input, remote text, or workspace version require a new preview', async () => {
  const f = await setup();
  try {
    const result = await f.preview();
    const input = {...result.input,previewHash:result.previewHash,idempotencyKey:'stale'};
    await assert.rejects(f.service.noteLinks.create(f.workspace.id,{...input,reason:'unreviewed'},'web'),{code:'LINK_PREVIEW_STALE'});
    f.flomo.memos.get('m2')!.content += '\nnew remote content';
    await assert.rejects(f.service.noteLinks.create(f.workspace.id,input,'web'),{code:'LINK_PREVIEW_STALE'});
    await f.store.updateWorkspace(f.workspace.id,1,'cli','draft',w => ({...w,draft:'new local draft'}));
    await assert.rejects(f.service.noteLinks.create(f.workspace.id,input,'web'),{code:'VERSION_CONFLICT'});
    assert.equal(f.flomo.writes.length,0);
    assert.equal((await f.store.listJobs()).length,0);
  } finally { await f.close(); }
});

test('a second-direction rejection retains the verified first link and records partial uncertainty', async () => {
  const f = await setup();
  try {
    f.flomo.failId = 'm2';
    const job = await f.create({direction:'bidirectional'}); await f.service.settle();
    const result = await f.store.getJob(job.id);
    assert.equal(result.status,'uncertain');
    assert.deepEqual(result.link!.steps.map(step => step.status),['verified','uncertain']);
    assert.match(f.flomo.memos.get('m1')!.content,/memo_id=m2/);
    assert.doesNotMatch(f.flomo.memos.get('m2')!.content,/memo_id=m1/);
    assert.equal((await f.service.reconcile(job.id)).status,'uncertain');
    assert.equal(f.flomo.writes.length,2);
    const workspace = await f.store.getWorkspace(f.workspace.id);
    await assert.rejects(f.service.rebase(workspace.id,workspace.version,'web'),{code:'PUBLISH_PENDING'});
    await assert.rejects(f.service.publish(workspace.id,workspace.version,'blocked','web'),{code:'PUBLISH_PENDING'});
  } finally { await f.close(); }
});

test('a target edited between directions is not overwritten and the first link is retained', async () => {
  const f = await setup();
  try {
    f.flomo.afterWrite = id => { if (id === 'm1') f.flomo.memos.get('m2')!.content = 'external edit'; };
    const job = await f.create({direction:'bidirectional'}); await f.service.settle();
    const result = await f.store.getJob(job.id);
    assert.equal(result.status,'uncertain');
    assert.deepEqual(result.link!.steps.map(step => step.status),['verified','failed']);
    assert.deepEqual(f.flomo.writes,['m1']);
    assert.equal(f.flomo.memos.get('m2')!.content,'external edit');
  } finally { await f.close(); }
});

test('lost responses reconcile by reading and never resend either direction', async () => {
  const f = await setup();
  try {
    f.flomo.timeoutId = 'm2';
    const job = await f.create({direction:'bidirectional'}); await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status,'uncertain');
    assert.equal((await f.service.reconcile(job.id)).status,'succeeded');
    assert.deepEqual(f.flomo.writes,['m1','m2']);
  } finally { await f.close(); }
});

test('manual abandonment refreshes snapshots, keeps partial links and releases tracking without resending', async () => {
  const f = await setup();
  try {
    f.flomo.failId = 'm2';
    const job = await f.create({direction:'bidirectional'}); await f.service.settle();
    const workspace = await f.store.getWorkspace(f.workspace.id);
    await assert.rejects(f.service.abandon(job.id,1,'web'),{code:'VERSION_CONFLICT'});
    const ended = await f.service.abandon(job.id,workspace.version,'web');
    assert.equal(ended.status,'failed');
    assert.equal(ended.link!.steps[0].status,'verified');
    assert.equal(f.flomo.writes.length,2);
    assert.equal((await f.store.getWorkspace(workspace.id)).draft,workspace.draft);
  } finally { await f.close(); }
});

test('link and publish starts use the same global write guard', async () => {
  for (const firstKind of ['link','publish']) {
    const f = await setup();
    try {
      const preview = await f.preview();
      const create = () => f.service.noteLinks.create(f.workspace.id,{...preview.input,previewHash:preview.previewHash,idempotencyKey:'link'},'web');
      const publish = () => f.service.publish(f.workspace.id,1,'publish','web');
      f.flomo.gate = deferred();
      await (firstKind === 'link' ? create() : publish());
      await f.flomo.started.promise;
      await assert.rejects(firstKind === 'link' ? publish() : create(),{code:'PUBLISH_PENDING'});
      assert.equal(f.flomo.writes.length,1);
    } finally { await f.close(); }
  }
});

test('restart keeps interrupted link steps uncertain and reconciliation is read-only', async () => {
  const dir = await mkdtemp(join(tmpdir(),'note-link-recovery-'));
  let store = await Store.open(join(dir,'cache.db')); const flomo = new FakeFlomo();
  try {
    let service = new WorkbenchService(store,flomo);
    const workspace = await service.createWorkspace('m1',undefined,'cli');
    const input = noteLinkInputSchema.parse({targetMemoId:'m2',baseVersion:1});
    const preview = await service.noteLinks.preview(workspace.id,input);
    const now = new Date().toISOString();
    const job:Job = {id:'interrupted',workspaceId:workspace.id,kind:'link',status:'running',actor:'cli',text:'',error:null,createdAt:now,updatedAt:now,
      baseVersion:1,idempotencyKey:'interrupted',link:{sourceMemoId:'m1',input,previewHash:preview.previewHash,steps:preview.steps.map(step => ({...step,status:'writing'}))}};
    await store.putJob(job);
    flomo.memos.get('m1')!.content = preview.steps[0].afterContent;
    flomo.memos.get('m1')!.linked_memos = ['m2'];
    await store.close(); store = await Store.open(join(dir,'cache.db')); service = new WorkbenchService(store,flomo);
    await service.recover();
    assert.equal((await store.getJob(job.id)).status,'uncertain');
    assert.equal((await store.getJob(job.id)).link!.steps[0].status,'uncertain');
    assert.equal((await service.reconcile(job.id)).status,'succeeded');
    assert.equal(flomo.writes.length,0);
    assert.equal((await store.getWorkspace(workspace.id)).draft,workspace.draft);
  } finally { await store.close(); await rm(dir,{recursive:true,force:true}); }
});

test('HTTP exposes preview, creation, cross-workspace history and rejects unchecked write input', async () => {
  const f = await setup(); const app = await createApp({service:f.service});
  try {
    const path = `/api/v1/workspaces/${f.workspace.id}/links`;
    const headers = {'x-workbench-actor':'mcp'};
    const missingActor = await app.inject({method:'POST',url:`${path}/preview`,payload:{targetMemoId:'m2',baseVersion:1}});
    assert.equal(missingActor.statusCode,403);
    const preview = await app.inject({method:'POST',url:`${path}/preview`,headers,payload:{targetMemoId:'m2',baseVersion:1}});
    assert.equal(preview.statusCode,200);
    assert.equal(preview.json().input.direction,'outgoing');
    assert.equal(f.flomo.writes.length,0);
    const unchecked = await app.inject({method:'POST',url:path,headers,payload:{targetMemoId:'m2',baseVersion:1,idempotencyKey:'x'}});
    assert.equal(unchecked.statusCode,400);
    const created = await app.inject({method:'POST',url:path,headers,payload:{...preview.json().input,previewHash:preview.json().previewHash,idempotencyKey:'http'}});
    assert.equal(created.statusCode,202); await f.service.settle();
    const history = await app.inject({method:'GET',url:path});
    assert.equal(history.json()[0].id,created.json().id);
    assert.equal(history.json()[0].status,'succeeded');
    assert.equal(history.json()[0].actor,'mcp');
  } finally { await app.close(); await f.store.close(); }
});
