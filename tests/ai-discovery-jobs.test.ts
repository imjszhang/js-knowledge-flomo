import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import sqlite3 from 'sqlite3';
import { createApp } from '../server/app.js';
import { ProviderError, type AIProvider, type FlomoProvider } from '../server/provider-types.js';
import { WorkbenchService } from '../server/service.js';
import { Store } from '../server/store.js';
import type { Actor, Change, Job, Memo, MemoSearch, Workspace } from '../shared/contracts.js';

const memo = (id: string): Memo => ({
  id, url: `https://v.flomoapp.com/mine/?memo_id=${id}`, content: `完整正文 ${id}：能力需要在具体需求中验证。`,
  tags: ['想法', '生态位'], created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T01:00:00Z',
  content_truncated: false, linked_memos: [],
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
class FakeFlomo implements FlomoProvider {
  searches: MemoSearch[] = [];
  found = true;
  searchStarted = deferred();
  searchGate?: ReturnType<typeof deferred>;
  async search(input: MemoSearch) {
    this.searches.push(input);
    this.searchStarted.resolve();
    await this.searchGate?.promise;
    return { memos: this.found ? [memo('candidate')] : [], scope: 'remote-search' as const,
      limit: input.limit ?? 20, possiblyLimited: false, checkedAt: '' };
  }
  async get(id: string) { return memo(id); }
  async related() { return []; }
  async tags() { return { tags: [], total: 0, returned: 0, truncated: false }; }
  async update(): Promise<Memo> { throw new Error('Discovery must not write to flomo'); }
}
type Reply = string | (() => Promise<string> | string);
class ScriptedAI implements AIProvider {
  calls: { workspace: Workspace; prompt: string }[] = [];
  constructor(readonly replies: Reply[]) {}
  async generate(workspace: Workspace, prompt: string, onChunk: (text: string) => void | Promise<void>) {
    this.calls.push({ workspace: structuredClone(workspace), prompt });
    const reply = this.replies.shift();
    assert.notEqual(reply, undefined, 'Unexpected additional AI request');
    const output = typeof reply === 'function' ? await reply() : reply!;
    await onChunk(output);
    return output;
  }
}
const plan = JSON.stringify({ terms: ['生态位', '定位'] });
const summary = '这条材料提供了核心判断的具体案例。';
const ranking = JSON.stringify({ summary, recommendations: [
  { memoId: 'candidate', reason: '说明能力需要放在实际需求中验证。', relation: 'example' },
] });
const input = (workspace: Workspace, key = 'discover-once') => ({
  instruction: '找实际案例', limit: 20, baseVersion: workspace.version, idempotencyKey: key,
});
async function fixture(t: TestContext, ai?: AIProvider, filename = ':memory:') {
  const store = await Store.open(filename);
  const flomo = new FakeFlomo();
  const service = new WorkbenchService(store, flomo, ai);
  const workspace = await service.createWorkspace('source', undefined, 'web');
  const app = await createApp({ service });
  const start = (payload: Record<string, unknown>, actor: Actor = 'cli') => app.inject({
    method: 'POST', url: `/api/v1/workspaces/${workspace.id}/discover/ai/jobs`,
    headers: { 'x-workbench-actor': actor }, payload,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    flomo.searchGate?.resolve();
    await app.close();
    await store.close();
  };
  t.after(close);
  return { store, flomo, service, workspace, app, start, close };
}

test('AI discovery starts with HTTP 202 before AI completes and shares all phases, filters and results', async t => {
  const planning = deferred(), planningGate = deferred(), rankingStarted = deferred(), rankingGate = deferred();
  const ai = new ScriptedAI([
    async () => { planning.resolve(); await planningGate.promise; return plan; },
    async () => { rankingStarted.resolve(); await rankingGate.promise; return ranking; },
  ]);
  const f = await fixture(t, ai);
  f.flomo.searchGate = deferred();
  const cursor = (await f.store.changes()).at(-1)!.id;
  const observed: Change[] = [];
  let observedJobId: string | undefined;
  const terminalSnapshots: Promise<{ change: Change; job: Job; workspace: Workspace }>[] = [];
  f.store.events.on('change', change => {
    observed.push(change);
    if (observedJobId && (change.entity === 'workspace' || change.entity === 'job' && change.kind === 'succeeded')) {
      terminalSnapshots.push(Promise.all([f.store.getJob(observedJobId), f.store.getWorkspace(f.workspace.id)])
        .then(([job, workspace]) => ({ change, job, workspace })));
    }
  });
  const filters = { tag: '想法', excludeTag: '概要', startDate: '2026-01-01', endDate: '2026-12-31' };
  try {
    const response = await promptly(f.start({ ...input(f.workspace), ...filters }, 'mcp'), 'Starting discovery waited for the AI response');
    assert.equal(response.statusCode, 202, response.body);
    const job = response.json<Job>();
    observedJobId = job.id;
    assert.equal(job.kind, 'discovery');
    assert.equal(job.status, 'running');
    assert.equal(job.actor, 'mcp');
    assert.equal(job.baseVersion, f.workspace.version);
    assert.equal(job.discovery?.phase, 'planning');
    assert.equal(job.discovery?.input.instruction, '找实际案例');
    for (const [key, value] of Object.entries(filters)) assert.equal((job.discovery?.input as Record<string, unknown>)[key], value);
    await promptly(planning.promise, 'AI planning did not start');
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id), f.workspace, 'Starting a job must not invalidate the workspace version');
    assert.equal((await f.app.inject(`/api/v1/jobs/${job.id}`)).json<Job>().status, 'running');
    assert.ok((await f.app.inject(`/api/v1/jobs?workspaceId=${f.workspace.id}`)).json<Job[]>().some(item => item.id === job.id));

    planningGate.resolve();
    await promptly(f.flomo.searchStarted.promise, 'Search phase did not start');
    assert.equal((await f.store.getJob(job.id)).discovery?.phase, 'searching');
    assert.deepEqual((await f.store.getJob(job.id)).discovery?.terms, ['生态位', '定位']);
    assert.equal((await f.store.getWorkspace(f.workspace.id)).version, f.workspace.version);
    f.flomo.searchGate.resolve();
    await promptly(rankingStarted.promise, 'Ranking phase did not start');
    assert.equal((await f.store.getJob(job.id)).discovery?.phase, 'ranking');
    assert.deepEqual((await f.store.getWorkspace(f.workspace.id)).materialCandidates, []);
    rankingGate.resolve();
    await f.service.settle();

    const finished = await f.store.getJob(job.id);
    const current = await f.store.getWorkspace(f.workspace.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.text, summary);
    assert.equal(finished.error, null);
    assert.equal(finished.discovery?.workspaceVersion, current.version);
    assert.deepEqual(finished.discovery?.result?.terms, ['生态位', '定位']);
    assert.equal(finished.discovery?.result?.readCount, 1);
    assert.equal(finished.discovery?.result?.ai?.recommendedCount, 1);
    assert.equal(finished.discovery?.result?.ai?.summary, summary);
    assert.equal(current.version, f.workspace.version + 1);
    assert.equal(current.draft, f.workspace.draft);
    assert.deepEqual(current.materials, []);
    assert.equal(current.materialCandidates?.[0].memo.content, memo('candidate').content);
    assert.equal(current.materialCandidates?.[0].status, 'proposed');
    for (const search of f.flomo.searches) for (const [key, value] of Object.entries(filters)) assert.equal((search as Record<string, unknown>)[key], value);
    const changes = (await f.app.inject(`/api/v1/changes?after=${cursor}`)).json<Change[]>();
    assert.deepEqual(changes, observed, 'Live notifications and durable replay must carry the same changes');
    assert.ok(changes.some(change => change.entity === 'workspace' && change.entityId === current.id));
    assert.ok(changes.some(change => change.entity === 'job' && change.entityId === job.id && change.kind === 'succeeded'));
    assert.ok(changes.every(change => change.actor === 'mcp'));
    const snapshots = await Promise.all(terminalSnapshots);
    assert.ok(snapshots.some(snapshot => snapshot.change.entity === 'workspace'));
    assert.ok(snapshots.some(snapshot => snapshot.change.entity === 'job'));
    for (const snapshot of snapshots) {
      assert.equal(snapshot.job.status, 'succeeded', 'Candidate observers must already see the successful terminal job');
      assert.equal(snapshot.workspace.materialCandidates?.[0].memo.id, 'candidate', 'Job observers must already see its saved candidates');
      assert.equal(snapshot.job.discovery?.workspaceVersion, snapshot.workspace.version);
    }
  } finally { planningGate.resolve(); f.flomo.searchGate.resolve(); rankingGate.resolve(); }
});

test('discovery job defaults and zero-result summaries persist without a workspace revision', async t => {
  for (const kind of ['no-search-results', 'no-recommendations'] as const) await t.test(kind, async t => {
    const ai = new ScriptedAI(kind === 'no-search-results' ? [plan] : [plan, JSON.stringify({ summary: '现有材料不足以支持这个判断。', recommendations: [] })]);
    const f = await fixture(t, ai);
    f.flomo.found = kind !== 'no-search-results';
    const cursor = (await f.store.changes()).at(-1)!.id;
    const response = await f.start({ baseVersion: 1, idempotencyKey: kind });
    assert.equal(response.statusCode, 202, response.body);
    const job = response.json<Job>();
    assert.equal(job.discovery?.input.instruction, '');
    assert.equal(job.discovery?.input.limit, 20);
    await f.service.settle();
    const finished = await f.store.getJob(job.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.discovery?.result?.ai?.recommendedCount, 0);
    assert.ok(finished.text.length > 0);
    assert.equal(finished.discovery?.result?.ai?.summary, finished.text);
    assert.equal(finished.discovery?.result?.readCount, kind === 'no-search-results' ? 0 : 1);
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id), f.workspace);
    assert.ok((await f.store.changes(cursor)).every(change => change.entity === 'job'));
    assert.equal((await f.store.changes(cursor)).at(-1)?.kind, 'succeeded');
  });
});

test('discovery failures remain inspectable and identical retries do not run the AI again', async t => {
  const ai = new ScriptedAI([plan, () => { throw new ProviderError('模型暂时不可用', 'AI_UNAVAILABLE'); }]);
  const f = await fixture(t, ai);
  const body = input(f.workspace);
  const job = await f.service.analysis.startDiscovery(f.workspace.id, body, 'cli');
  await f.service.settle();
  const failed = await f.store.getJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /模型暂时不可用/);
  assert.equal(failed.discovery?.errorCode, 'AI_UNAVAILABLE');
  assert.equal(failed.discovery?.result, undefined);
  assert.deepEqual(await f.store.getWorkspace(f.workspace.id), f.workspace);
  const retry = await f.service.analysis.startDiscovery(f.workspace.id, body, 'mcp');
  assert.deepEqual(retry, failed);
  assert.equal(ai.calls.length, 2);
  assert.equal((await f.store.listJobs()).length, 1);
});

test('discovery idempotency survives completion and rejects changed requests without AI calls', async t => {
  const ai = new ScriptedAI([plan, ranking]);
  const f = await fixture(t, ai);
  const body = input(f.workspace);
  const job = await f.service.analysis.startDiscovery(f.workspace.id, body, 'cli');
  await f.service.settle();
  assert.equal((await f.store.getWorkspace(f.workspace.id)).version, 2);
  const retry = await f.service.analysis.startDiscovery(f.workspace.id, body, 'cli');
  assert.equal(retry.id, job.id);
  assert.equal(retry.status, 'succeeded', 'An exact retry must be checked before the now-stale workspace version');
  for (const patch of [{ instruction: '换个方向' }, { limit: 10 }, { baseVersion: 2 }, { tag: '新标签' }]) {
    await assert.rejects(f.service.analysis.startDiscovery(f.workspace.id, { ...body, ...patch }, 'cli'), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.equal(ai.calls.length, 2);
  assert.equal((await f.store.listJobs()).length, 1);
});

test('concurrent starts share an idempotent job and a different key is rejected while running', async t => {
  const entered = deferred(), gate = deferred();
  const ai = new ScriptedAI([async () => { entered.resolve(); await gate.promise; return plan; }, ranking]);
  const f = await fixture(t, ai);
  try {
    const body = input(f.workspace);
    const [first, retry] = await Promise.all([
      f.service.analysis.startDiscovery(f.workspace.id, body, 'cli'),
      f.service.analysis.startDiscovery(f.workspace.id, body, 'mcp'),
    ]);
    assert.equal(first.id, retry.id);
    await promptly(entered.promise, 'AI planning did not start');
    await assert.rejects(f.service.analysis.startDiscovery(f.workspace.id, { ...body, idempotencyKey: 'second' }, 'mcp'), { code: 'AI_DISCOVERY_RUNNING' });
    await assert.rejects(f.service.analysis.discoverWithAI(f.workspace.id, { instruction: '', limit: 20, baseVersion: 1 }, 'web'), { code: 'AI_DISCOVERY_RUNNING' });
    assert.equal(ai.calls.length, 1);
    assert.equal((await f.store.listJobs()).length, 1);
  } finally { gate.resolve(); await f.service.settle(); }
});

test('an edit made during discovery is preserved and the job records a version conflict', async t => {
  const entered = deferred(), gate = deferred();
  const ai = new ScriptedAI([plan, async () => { entered.resolve(); await gate.promise; return ranking; }]);
  const f = await fixture(t, ai);
  try {
    const job = await f.service.analysis.startDiscovery(f.workspace.id, input(f.workspace), 'mcp');
    await promptly(entered.promise, 'AI ranking did not start');
    const edited = await f.store.updateWorkspace(f.workspace.id, 1, 'web', 'draft', workspace => ({ ...workspace, draft: '用户继续编辑的内容' }));
    gate.resolve();
    await f.service.settle();
    const failed = await f.store.getJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.discovery?.errorCode, 'VERSION_CONFLICT');
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id), edited);
    assert.deepEqual(edited.materialCandidates, []);
  } finally { gate.resolve(); }
});

test('invalid discovery starts and unavailable AI do not leave jobs or workspace changes', async t => {
  const ai = new ScriptedAI([]);
  const f = await fixture(t, ai);
  const invalid = [
    { baseVersion: 1 }, { baseVersion: 1, idempotencyKey: '' },
    { baseVersion: 1, idempotencyKey: 'x', limit: 31 },
    { baseVersion: 1, idempotencyKey: 'x', instruction: '长'.repeat(2001) },
    { baseVersion: 1, idempotencyKey: 'x', terms: ['manual'] },
    { baseVersion: 1, idempotencyKey: 'x', startDate: '2026-02-30' },
    { baseVersion: 1, idempotencyKey: 'x', startDate: '2026-10-13', endDate: '2026-10-01' },
  ];
  for (const body of invalid) {
    const response = await f.start(body);
    assert.equal(response.statusCode, 400, response.body);
  }
  const stale = await f.start({ baseVersion: 2, idempotencyKey: 'stale' });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
  const missingActor = await f.app.inject({ method: 'POST', url: `/api/v1/workspaces/${f.workspace.id}/discover/ai/jobs`, payload: input(f.workspace) });
  assert.equal(missingActor.statusCode, 403);
  assert.equal(ai.calls.length, 0);
  assert.equal(f.flomo.searches.length, 0);
  assert.deepEqual(await f.store.listJobs(), []);
  assert.deepEqual(await f.store.getWorkspace(f.workspace.id), f.workspace);
  const unconfigured = await fixture(t);
  const response = await unconfigured.start(input(unconfigured.workspace));
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error.code, 'AI_NOT_CONFIGURED');
  assert.deepEqual(await unconfigured.store.listJobs(), []);
});

test('completed discovery and interrupted-job recovery survive closing and reopening the database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-discovery-jobs-'));
  const filename = join(directory, 'workbench.db');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, new ScriptedAI([plan, ranking]), filename);
  const body = input(f.workspace);
  const started = await f.service.analysis.startDiscovery(f.workspace.id, body, 'cli');
  await f.service.settle();
  const completed = await f.store.getJob(started.id);
  const workspace = await f.store.getWorkspace(f.workspace.id);
  await f.store.putJob({ ...completed, id: 'interrupted-discovery', status: 'running', text: '',
    idempotencyKey: 'interrupted', discovery: { input: completed.discovery!.input, phase: 'searching', terms: ['生态位'] } });
  const cursor = (await f.store.changes()).at(-1)!.id;
  await f.close();
  const store = await Store.open(filename);
  const ai = new ScriptedAI([]);
  const service = new WorkbenchService(store, new FakeFlomo(), ai);
  try {
    await service.recover();
    assert.deepEqual(await store.getJob(completed.id), completed);
    assert.deepEqual(await store.getWorkspace(workspace.id), workspace);
    const recovered = await store.getJob('interrupted-discovery');
    assert.equal(recovered.status, 'failed', 'Discovery is a local read workflow, not an uncertain remote publication');
    assert.match(recovered.error ?? '', /中断/);
    assert.deepEqual(recovered.discovery?.terms, ['生态位']);
    assert.ok((await store.changes(cursor)).some(change => change.entityId === recovered.id && change.kind === 'failed'));
    const retry = await service.analysis.startDiscovery(workspace.id, body, 'mcp');
    assert.equal(retry.id, completed.id);
    assert.equal(ai.calls.length, 0);
  } finally { await service.close(); await store.close(); }
});

test('a failed terminal-job write cannot commit its candidate update or candidate change event', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-discovery-atomic-'));
  const filename = join(directory, 'workbench.db');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entered = deferred(), gate = deferred();
  const ai = new ScriptedAI([plan, async () => { entered.resolve(); await gate.promise; return ranking; }]);
  const f = await fixture(t, ai, filename);
  let observer: sqlite3.Database | undefined;
  try {
    const job = await f.service.analysis.startDiscovery(f.workspace.id, input(f.workspace), 'cli');
    await promptly(entered.promise, 'AI ranking did not start');
    observer = await new Promise<sqlite3.Database>((resolve, reject) => {
      const handle = new sqlite3.Database(filename, error => error ? reject(error) : resolve(handle));
    });
    await new Promise<void>((resolve, reject) => observer!.exec(`
      CREATE TRIGGER fail_discovery_success BEFORE UPDATE ON workbench_jobs
      WHEN NEW.kind = 'discovery' AND json_extract(NEW.data, '$.status') = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'test terminal job write failure'); END;
    `, error => error ? reject(error) : resolve()));
    const cursor = (await f.store.changes()).at(-1)!.id;
    gate.resolve();
    await f.service.settle();
    assert.deepEqual(await f.store.getWorkspace(f.workspace.id), f.workspace);
    assert.equal((await f.store.getJob(job.id)).status, 'failed');
    assert.ok((await f.store.changes(cursor)).every(change => change.entity !== 'workspace'));
  } finally {
    gate.resolve();
    if (observer) await new Promise<void>((resolve, reject) => observer!.close(error => error ? reject(error) : resolve()));
  }
});
