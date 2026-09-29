import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli, WorkbenchClient } from '../cli/workbench.js';
import { createWorkbenchMcpServer } from '../mcp-server/workbench.js';

type Request = { method: string; path: string; body: unknown; actor: string | undefined };
async function withService(respond: (request: Request) => { status?: number; body: unknown }, run: (client: WorkbenchClient, calls: Request[]) => Promise<void>) {
  const calls: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = { method: req.method!, path: req.url!, body: body ? JSON.parse(body) : undefined, actor: req.headers['x-workbench-actor'] as string | undefined };
    calls.push(request);
    const response = respond(request);
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(new WorkbenchClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function invoke(client: WorkbenchClient, args: string[]) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, stdin: async () => '' }, client);
  return { code, stdout, stderr };
}
async function withFiles(run: (resultPath: string, cardPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-analysis-cli-'));
  const resultPath = join(directory, 'result.json'), cardPath = join(directory, 'card.json');
  try {
    await writeFile(resultPath, JSON.stringify({ text: '这是分析结果 [flomo:m1]。', cards: [card] }));
    await writeFile(cardPath, JSON.stringify(card));
    await run(resultPath, cardPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const card = { title: '能力优势需要需求验证', body: '一个独立判断。\n依据来自选定的材料。', tags: ['想法', '生态位'], sourceKeys: ['flomo:m1'] };

test('discovery CLI keeps separate terms and filters, resolves current once and returns scope metadata', async () => {
  const discovery = { workspace: { id: 'w/一', version: 5 }, terms: ['生态位', '定位', '竞争'], possiblyLimited: true, readCount: 2, omitted: [{ memoId: 'm3', reason: '全文不可读' }] };
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w/一', revision: 7 } : discovery }), async (client, calls) => {
    const result = await invoke(client, ['material', 'discover', 'current', '--terms', ' 生态位，定位,\n竞争 ', '--tag', '想法', '--exclude-tag', '概要', '--start-date', '2025-01-01', '--end-date', '2026-09-30', '--limit', '8', '--base-version', '4', '--context-revision', '7', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), discovery);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/discover', body: { terms: ['生态位', '定位', '竞争'], tag: '想法', excludeTag: '概要', startDate: '2025-01-01', endDate: '2026-09-30', limit: 8, baseVersion: 4 }, actor: 'cli' },
    ]);
  });
});

test('analysis CLI prepares and completes external analysis, edits cards and publishes only when explicitly requested', async () => {
  await withFiles(async (resultPath, cardPath) => {
    const record = { id: 'a/一', status: 'prepared', sources: [{ key: 'flomo:m1', content: '完整原文' }], instructions: '按证据分析。' };
    await withService(request => ({ body: request.method === 'GET' ? (request.path.endsWith('/analyses') ? [record] : record) : { id: 'w/一', version: 5, analyses: [record] } }), async (client, calls) => {
      const commands = [
        ['analysis', 'create', 'w/一', '--kind', 'cards', '--engine', 'external', '--question', '哪个判断值得独立写？', '--basis', 'basis-1', '--base-version', '4', '--idempotency-key', 'prepare-1'],
        ['analysis', 'list', 'w/一'],
        ['analysis', 'get', 'w/一', '--analysis', 'a/一'],
        ['analysis', 'complete', 'w/一', '--analysis', 'a/一', '--file', resultPath, '--base-version', '5'],
        ['analysis', 'card-update', 'w/一', '--analysis', 'a/一', '--card', 'c/一', '--file', cardPath, '--base-version', '6'],
      ];
      for (const args of commands) {
        const result = await invoke(client, args);
        assert.equal(result.code, 0, result.stderr);
        if (args[1] === 'get') assert.deepEqual(JSON.parse(result.stdout), record);
      }
      assert.ok(calls.every(call => !call.path.endsWith('/publish')), 'local review commands must not publish notes');
      assert.equal((await invoke(client, ['analysis', 'card-publish', 'w/一', '--analysis', 'a/一', '--card', 'c/一', '--base-version', '7', '--idempotency-key', 'publish-1'])).code, 0);
      const base = '/api/v1/workspaces/w%2F%E4%B8%80/analyses';
      assert.deepEqual(calls.map(({ actor, ...call }) => { assert.equal(actor, 'cli'); return call; }), [
        { method: 'POST', path: base, body: { kind: 'cards', question: '哪个判断值得独立写？', engine: 'external', basisAnalysisId: 'basis-1', baseVersion: 4, idempotencyKey: 'prepare-1' } },
        { method: 'GET', path: base, body: undefined },
        { method: 'GET', path: `${base}/a%2F%E4%B8%80`, body: undefined },
        { method: 'POST', path: `${base}/a%2F%E4%B8%80/result`, body: { text: '这是分析结果 [flomo:m1]。', cards: [card], baseVersion: 5 } },
        { method: 'PATCH', path: `${base}/a%2F%E4%B8%80/cards/c%2F%E4%B8%80`, body: { ...card, baseVersion: 6 } },
        { method: 'POST', path: `${base}/a%2F%E4%B8%80/cards/c%2F%E4%B8%80/publish`, body: { baseVersion: 7, idempotencyKey: 'publish-1' } },
      ]);
    });
  });
});

test('new CLI commands reject invalid analysis inputs before resolving the active workspace', async () => {
  await withFiles(async (resultPath, cardPath) => {
    await withService(() => ({ body: {} }), async (client, calls) => {
      const badArgs = [
        ['material', 'discover', 'current', '--terms', ',\n', '--base-version', '1'],
        ['material', 'discover', 'current', '--terms', '1,2,3,4,5,6,7', '--base-version', '1'],
        ['material', 'discover', 'current', '--terms', '生态位', '--limit', '31', '--base-version', '1'],
        ['material', 'discover', 'current', '--terms', '生态位', '--start-date', 'yesterday', '--base-version', '1'],
        ['analysis', 'create', 'current', '--kind', 'unknown', '--engine', 'external', '--base-version', '1', '--idempotency-key', 'k'],
        ['analysis', 'create', 'current', '--kind', 'insights', '--engine', 'remote', '--base-version', '1', '--idempotency-key', 'k'],
        ['analysis', 'create', 'current', '--kind', 'insights', '--engine', 'external', '--base-version', '1'],
        ['analysis', 'get', 'current'],
        ['analysis', 'list', ''],
        ['analysis', 'card-publish', 'current', '--analysis', 'a', '--base-version', '1', '--idempotency-key', 'k'],
        ['analysis', 'complete', 'current', '--analysis', 'a', '--file', resultPath, '--base-version', '0'],
      ];
      for (const args of badArgs) assert.equal((await invoke(client, args)).code, 2, JSON.stringify(args));
      for (const value of [[], { text: 'result', baseVersion: 90 }, { text: 'result', unknown: 'field' }, { text: '' }, { text: 'result', cards: [{ ...card, sourceKeys: [] }] }]) {
        await writeFile(resultPath, JSON.stringify(value));
        assert.equal((await invoke(client, ['analysis', 'complete', 'current', '--analysis', 'a', '--file', resultPath, '--base-version', '1'])).code, 2);
      }
      await writeFile(cardPath, JSON.stringify({ ...card, tags: ['#想法'] }));
      assert.equal((await invoke(client, ['analysis', 'card-update', 'current', '--analysis', 'a', '--card', 'c', '--file', cardPath, '--base-version', '1'])).code, 2);
      assert.equal(calls.length, 0);
    });
  });
});

test('all new current mutations require context revision and preserve server conflicts without retry', async () => {
  await withFiles(async (resultPath, cardPath) => {
    await withService(request => request.path === '/api/v1/context' ? { body: { workspaceId: 'other', revision: 9 } } : { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'Review the updated workspace.', details: { actualVersion: 10 } } } }, async (client, calls) => {
      const mutations = [
        ['material', 'discover', 'current', '--terms', '生态位', '--base-version', '1'],
        ['analysis', 'create', 'current', '--kind', 'insights', '--engine', 'builtin', '--base-version', '1', '--idempotency-key', 'k'],
        ['analysis', 'complete', 'current', '--analysis', 'a', '--file', resultPath, '--base-version', '1'],
        ['analysis', 'card-update', 'current', '--analysis', 'a', '--card', 'c', '--file', cardPath, '--base-version', '1'],
        ['analysis', 'card-publish', 'current', '--analysis', 'a', '--card', 'c', '--base-version', '1', '--idempotency-key', 'k'],
      ];
      for (const args of mutations) {
        const result = await invoke(client, args);
        assert.equal(result.code, 2);
        assert.equal(JSON.parse(result.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
      }
      assert.equal(calls.length, 0);
      const stale = await invoke(client, [...mutations[1]!, '--context-revision', '8']);
      assert.equal(stale.code, 3);
      assert.equal(JSON.parse(stale.stderr).error.code, 'CONTEXT_CONFLICT');
      assert.equal(calls.length, 1);
      const publish = mutations[4]!.map(value => value === 'current' ? 'w1' : value);
      const conflict = await invoke(client, publish);
      assert.equal(conflict.code, 3);
      assert.equal(conflict.stdout, '');
      assert.equal(JSON.parse(conflict.stderr).error.details.actualVersion, 10);
      assert.equal(calls.length, 2, 'must not blindly retry with a new version or key');
    });
  });
});

test('analysis MCP exposes shared structured inputs, context protection and the prepare/review/publish workflow', async () => {
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w1', revision: 3 } : { version: 5 } }), async (httpClient, calls) => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'analysis-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      const requests = [
        { name: 'workbench_material_discover', arguments: { id: 'w1', terms: ['生态位', '竞争'], baseVersion: 1 } },
        { name: 'workbench_analysis_create', arguments: { id: 'w1', kind: 'cards', engine: 'external', baseVersion: 2, idempotencyKey: 'prepare' } },
        { name: 'workbench_analysis_list', arguments: { id: 'w1' } },
        { name: 'workbench_analysis_get', arguments: { id: 'w1', analysisId: 'a/一' } },
        { name: 'workbench_analysis_complete', arguments: { id: 'w1', analysisId: 'a/一', text: '有来源的分析。', cards: [card], baseVersion: 3 } },
        { name: 'workbench_analysis_card_update', arguments: { id: 'w1', analysisId: 'a/一', cardId: 'c/1', ...card, baseVersion: 4 } },
        { name: 'workbench_analysis_card_publish', arguments: { id: 'w1', analysisId: 'a/一', cardId: 'c/1', baseVersion: 5, idempotencyKey: 'publish' } },
      ];
      for (const request of requests) assert.ok(inventory.tools.some(tool => tool.name === request.name), `Missing ${request.name}`);
      for (const request of requests.filter(request => 'baseVersion' in request.arguments)) {
        const missing = await client.callTool({ ...request, arguments: { ...request.arguments, id: 'current' } });
        assert.equal(missing.isError, true);
        assert.equal(JSON.parse((missing.content as { text: string }[])[0]!.text).error.code, 'CONTEXT_REVISION_REQUIRED');
      }
      const invalid = await client.callTool({ name: 'workbench_analysis_complete', arguments: { id: 'current', analysisId: 'a', text: 'test', cards: [{ ...card, sourceKeys: [] }], baseVersion: 1, contextRevision: 3 } });
      assert.equal(invalid.isError, true);
      assert.equal(calls.length, 0, 'validation happens before HTTP');
      for (const request of requests) assert.equal((await client.callTool(request)).isError, undefined);
      const base = '/api/v1/workspaces/w1/analyses';
      assert.deepEqual(calls.map(({ actor, ...call }) => { assert.equal(actor, 'mcp'); return call; }), [
        { method: 'POST', path: '/api/v1/workspaces/w1/discover', body: { terms: ['生态位', '竞争'], limit: 20, baseVersion: 1 } },
        { method: 'POST', path: base, body: { kind: 'cards', question: '', engine: 'external', baseVersion: 2, idempotencyKey: 'prepare' } },
        { method: 'GET', path: base, body: undefined },
        { method: 'GET', path: `${base}/a%2F%E4%B8%80`, body: undefined },
        { method: 'POST', path: `${base}/a%2F%E4%B8%80/result`, body: { text: '有来源的分析。', cards: [card], baseVersion: 3 } },
        { method: 'PATCH', path: `${base}/a%2F%E4%B8%80/cards/c%2F1`, body: { ...card, baseVersion: 4 } },
        { method: 'POST', path: `${base}/a%2F%E4%B8%80/cards/c%2F1/publish`, body: { baseVersion: 5, idempotencyKey: 'publish' } },
      ]);
      assert.equal((await client.callTool({ ...requests[1]!, arguments: { ...requests[1]!.arguments, id: 'current', contextRevision: 3 } })).isError, undefined);
      assert.deepEqual(calls.slice(-2).map(call => call.path), ['/api/v1/context', base]);
      assert.ok(!('contextRevision' in (calls.at(-1)!.body as Record<string, unknown>)));
    } finally { await client.close(); await server.close(); }
  });
});
