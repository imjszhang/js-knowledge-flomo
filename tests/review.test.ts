import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Memo, Settings } from '../shared/contracts.js';
import type { AIProvider, FlomoProvider } from '../server/provider-types.js';
import { Store } from '../server/store.js';
import { WorkbenchService } from '../server/service.js';
import { createApp } from '../server/app.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function memo(id: string): Memo {
  return { id, url: `https://v.flomoapp.com/mine/?memo_id=${id}`, content: `Original ${id} #待编/想法`, tags: ['待编/想法'],
    created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', content_truncated: false, linked_memos: [] };
}
class ReviewFlomo implements FlomoProvider {
  memos = new Map(['m1', 'm2'].map(id => [id, memo(id)]));
  writes = 0;
  active = 0;
  maxActive = 0;
  gate?: ReturnType<typeof deferred>;
  started = deferred();
  mismatch = false;
  async get(id: string) {
    const value = this.memos.get(id);
    if (!value) throw new Error('Unknown fake memo');
    return structuredClone(value);
  }
  async search() { return { memos: [...this.memos.values()], scope: 'remote-search' as const, limit: 30, possiblyLimited: false, checkedAt: new Date().toISOString() }; }
  async tags() { return { tags: ['待编/想法'], returned: 1, total: 1, truncated: false }; }
  async related() { return []; }
  async update(id: string, content: string, expectedUpdatedAt?: string, expectedContent?: string) {
    const source = await this.get(id);
    assert.equal(source.updated_at, expectedUpdatedAt);
    assert.equal(source.content, expectedContent);
    this.writes++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.resolve();
    try {
      await this.gate?.promise;
      const result = { ...source, content: this.mismatch ? 'Different remote content' : content, updated_at: '2026-09-29T01:00:00Z' };
      this.memos.set(id, result);
      return structuredClone(result);
    } finally { this.active--; }
  }
}
async function setup(ai?: AIProvider) {
  const store = await Store.open(':memory:');
  const flomo = new ReviewFlomo();
  const service = new WorkbenchService(store, flomo, ai);
  return { store, flomo, service, close: async () => { flomo.gate?.resolve(); await service.close(); await store.close(); } };
}

test('global publication serialization permits only one active remote write across two workspaces', async () => {
  const f = await setup();
  try {
    const first = await f.service.createWorkspace('m1', undefined, 'web');
    const second = await f.service.createWorkspace('m2', undefined, 'cli');
    f.flomo.gate = deferred();
    const attempts = await Promise.allSettled([
      f.service.publish(first.id, 1, 'global-first', 'web'),
      f.service.publish(second.id, 1, 'global-second', 'cli'),
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    const rejected = attempts.find(attempt => attempt.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'PUBLISH_PENDING');
    await f.flomo.started.promise;
    assert.equal(f.flomo.writes, 1);
    assert.equal((await f.store.listJobs()).filter(job => job.status === 'running').length, 1);
    f.flomo.gate.resolve();
    await f.service.settle();
    const retry = await f.service.publish(second.id, 1, 'global-second', 'cli');
    await f.service.settle();
    assert.equal((await f.store.getJob(retry.id)).status, 'succeeded');
    assert.equal(f.flomo.writes, 2);
    assert.equal(f.flomo.maxActive, 1);
  } finally { await f.close(); }
});

test('AI idempotency suppresses simultaneous and completed retries and rejects changed payloads', async () => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const f = await setup({ async generate(_workspace, prompt, onChunk) {
    calls++;
    await onChunk(`Answer to ${prompt}`);
    started.resolve();
    await gate.promise;
    return `Answer to ${prompt}`;
  } });
  try {
    const workspace = await f.service.createWorkspace('m1', undefined, 'web');
    const [job, duplicate] = await Promise.all([
      f.service.generate(workspace.id, 'Question', 1, 'same-request', 'cli'),
      f.service.generate(workspace.id, 'Question', 1, 'same-request', 'mcp'),
    ]);
    assert.equal(job.id, duplicate.id);
    await started.promise;
    assert.equal(calls, 1);
    await assert.rejects(f.service.generate(workspace.id, 'Different question', 1, 'same-request', 'web'), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.service.generate(workspace.id, 'Question', 2, 'same-request', 'web'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await f.store.getWorkspace(workspace.id)).messages.filter(message => message.role === 'user').length, 1);
    gate.resolve();
    await f.service.settle();
    const completedRetry = await f.service.generate(workspace.id, 'Question', 1, 'same-request', 'web');
    assert.equal(completedRetry.id, job.id);
    assert.equal(completedRetry.status, 'succeeded');
    assert.equal(calls, 1);
    assert.deepEqual((await f.store.getWorkspace(workspace.id)).messages.map(message => message.role), ['user', 'assistant']);
  } finally { gate.resolve(); await f.close(); }
});

test('mismatched publication remains uncertain after reconciliation and never enables an automatic second write', async () => {
  const f = await setup();
  try {
    const first = await f.service.createWorkspace('m1', undefined, 'web');
    const second = await f.service.createWorkspace('m2', undefined, 'cli');
    f.flomo.mismatch = true;
    const job = await f.service.publish(first.id, 1, 'unconfirmed', 'web');
    await f.service.settle();
    assert.equal((await f.store.getJob(job.id)).status, 'uncertain');
    assert.equal((await f.store.getWorkspace(first.id)).source.content, first.source.content);
    const reconciled = await f.service.reconcile(job.id);
    assert.equal(reconciled.status, 'uncertain');
    assert.equal(f.flomo.writes, 1);
    const current = await f.store.getWorkspace(first.id);
    assert.equal(current.remote?.content, 'Different remote content');
    assert.equal(current.draft, first.draft);
    await assert.rejects(f.service.publish(second.id, 1, 'must-not-overlap', 'cli'), { code: 'PUBLISH_PENDING' });
    // Only observing the exact target later establishes the outcome without a new write.
    f.flomo.memos.set(first.memoId, { ...memo(first.memoId), content: job.targetContent!, updated_at: '2026-09-29T02:00:00Z' });
    assert.equal((await f.service.reconcile(job.id)).status, 'succeeded');
    assert.equal(f.flomo.writes, 1);
  } finally { await f.close(); }
});

test('SSE replays more than 1000 persisted changes, honors Last-Event-ID, and then streams live updates exactly once', async () => {
  const f = await setup();
  const app = await createApp({ service: f.service });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const settings: Settings = { pinnedTags: ['待编'], refreshSeconds: 0 };
  try {
    for (let index = 0; index < 1105; index++) await f.store.setSettings(settings, 'cli');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    // A real EventSource reconnect keeps its URL but updates Last-Event-ID.
    const response = await fetch(`${address}/api/v1/events?after=0`, { headers: { 'last-event-id': '77' }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('event: ready')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      buffer += decoder.decode(next.value, { stream: true });
    }
    const replayed = [...buffer.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    assert.deepEqual(replayed, Array.from({ length: 1105 - 77 }, (_, index) => index + 78));
    assert.match(buffer, /event: ready\ndata: \{"cursor":1105\}/);
    await f.store.setSettings({ ...settings, pinnedTags: ['待编', '想法'] }, 'mcp');
    while (!buffer.includes('id: 1106\n')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      buffer += decoder.decode(next.value, { stream: true });
    }
    const allIds = [...buffer.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    assert.deepEqual(allIds, Array.from({ length: 1106 - 77 }, (_, index) => index + 78));
    assert.match(buffer, /"actor":"mcp"/);
    await reader.cancel();
    reader.releaseLock();
  } finally { clearTimeout(timeout); controller.abort(); await app.close(); await f.close(); }
});
