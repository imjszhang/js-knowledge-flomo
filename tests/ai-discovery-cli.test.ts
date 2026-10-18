import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
async function withMcp(httpClient: WorkbenchClient, run: (client: Client) => Promise<void>) {
  const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
  const client = new Client({ name: 'ai-discovery-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally { await client.close(); await server.close(); }
}
const job = { id: 'j/一', workspaceId: 'w/一', kind: 'discovery', status: 'running', text: '', discovery: { input: { instruction: '', limit: 20, baseVersion: 4 }, phase: 'planning' } };
const cliCommand = ['material', 'discover-ai', 'w/一', '--base-version', '4', '--idempotency-key', 'find-1'];
const toolName = 'workbench_material_discover_ai';
const toolInput = { id: 'w/一', baseVersion: 4, idempotencyKey: 'find-1' };
const decode = (response: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((response.content as { text: string }[])[0]!.text);

test('AI discovery CLI starts a durable job without requiring a Web selection and returns its running state', async () => {
  await withService(() => ({ status: 202, body: job }), async (client, calls) => {
    const result = await invoke(client, [...cliCommand, '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), job);
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/discover/ai/jobs', body: { instruction: '', limit: 20, baseVersion: 4, idempotencyKey: 'find-1' }, actor: 'cli' }]);
    const help = await invoke(client, ['--help']);
    assert.match(help.stdout, /material discover-ai starts a background AI search and returns a job/);
    assert.match(help.stdout, /job get JOB_ID/);
    assert.match(help.stdout, /material decide/);
  });
});

test('AI discovery CLI resolves current only once and preserves filters and trimmed instructions', async () => {
  let selection = 'w/一';
  await withService(request => {
    if (request.path === '/api/v1/context') {
      const workspaceId = selection;
      selection = 'different-workspace';
      return { body: { workspaceId, revision: 7 } };
    }
    return { status: 202, body: job };
  }, async (client, calls) => {
    const result = await invoke(client, ['material', 'discover-ai', 'current', '--instruction', '  找反例和具体案例  ', '--tag', '想法', '--exclude-tag', '概要', '--start-date', '2025-01-01', '--end-date', '2026-10-13', '--limit', '8', '--base-version', '4', '--idempotency-key', 'filtered-1', '--context-revision', '7']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/discover/ai/jobs', body: { instruction: '找反例和具体案例', tag: '想法', excludeTag: '概要', startDate: '2025-01-01', endDate: '2026-10-13', limit: 8, baseVersion: 4, idempotencyKey: 'filtered-1' }, actor: 'cli' },
    ]);
  });
});

test('AI discovery CLI rejects invalid arguments and unconfirmed current selection before network calls', async () => {
  await withService(() => ({ body: { workspaceId: 'other', revision: 8 } }), async (client, calls) => {
    const options = ['--base-version', '4', '--idempotency-key', 'find-1'];
    const invalid = [
      ['material', 'discover-ai', '', ...options],
      ['material', 'discover-ai', 'w1', '--base-version', '4'],
      ['material', 'discover-ai', 'w1', '--idempotency-key', 'find-1'],
      ...[['--instruction', 'a'.repeat(2001)], ['--tag', 'a'.repeat(201)], ['--limit', '31'], ['--limit', '0'], ['--limit', '1.5'], ['--start-date', 'yesterday'], ['--end-date', '2026-1-1'], ['--terms', '生态位'], ['--context-revision', '-1']].map(extra => ['material', 'discover-ai', 'current', ...options, ...extra]),
      ['material', 'discover-ai', 'w1', '--base-version', '0', '--idempotency-key', 'find-1'],
      ['material', 'discover-ai', 'w1', '--base-version', '4', '--idempotency-key', ''],
      ['material', 'discover-ai', 'w1', '--base-version', '4', '--idempotency-key', 'a'.repeat(201)],
    ];
    for (const args of invalid) assert.equal((await invoke(client, args)).code, 2, JSON.stringify(args));
    const missing = await invoke(client, ['material', 'discover-ai', 'current', ...options]);
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
    assert.equal(calls.length, 0);
    const stale = await invoke(client, ['material', 'discover-ai', 'current', ...options, '--context-revision', '7']);
    assert.equal(stale.code, 3);
    assert.equal(JSON.parse(stale.stderr).error.code, 'CONTEXT_CONFLICT');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });
});

test('AI discovery CLI preserves service errors and never retries with altered versions or keys', async () => {
  for (const status of [403, 409]) await withService(() => ({ status, body: { error: { code: status === 403 ? 'AI_FORBIDDEN' : 'VERSION_CONFLICT', message: 'Review the current state.', details: { actualVersion: 9 } } } }), async (client, calls) => {
    const result = await invoke(client, cliCommand);
    assert.equal(result.code, status === 409 ? 3 : 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).error, { code: status === 403 ? 'AI_FORBIDDEN' : 'VERSION_CONFLICT', message: 'Review the current state.', details: { actualVersion: 9 } });
    assert.equal(calls.length, 1);
  });
});

test('AI discovery MCP advertises asynchronous shared-state behavior and validates defaults and guards', async () => {
  await withService(request => request.path === '/api/v1/context' ? { body: { workspaceId: 'w/一', revision: 7 } } : { status: 202, body: job }, async (httpClient, calls) => {
    await withMcp(httpClient, async client => {
      const inventory = await client.listTools();
      const tool = inventory.tools.find(item => item.name === toolName)!;
      assert.ok(tool);
      assert.match(tool.description!, /running discovery job, not completed results/);
      assert.match(tool.description!, /material_decide/);
      assert.match(tool.description!, /without an open page/);
      assert.deepEqual(new Set(tool.inputSchema.required), new Set(['id', 'baseVersion', 'idempotencyKey']));
      assert.equal((tool.inputSchema.properties!.instruction as { default: string }).default, '');
      assert.equal((tool.inputSchema.properties!.limit as { default: number }).default, 20);
      assert.equal((tool.inputSchema.properties!.limit as { maximum: number }).maximum, 30);
      for (const args of [{ ...toolInput, instruction: 'a'.repeat(2001) }, { ...toolInput, limit: 31 }, { ...toolInput, startDate: 'yesterday' }, { ...toolInput, idempotencyKey: '' }, { ...toolInput, baseVersion: 0 }, { ...toolInput, contextRevision: -1 }]) {
        assert.equal((await client.callTool({ name: toolName, arguments: args })).isError, true);
      }
      const missing = await client.callTool({ name: toolName, arguments: { ...toolInput, id: 'current' } });
      assert.equal(missing.isError, true);
      assert.equal(decode(missing).error.code, 'CONTEXT_REVISION_REQUIRED');
      assert.equal(calls.length, 0);
      const stale = await client.callTool({ name: toolName, arguments: { ...toolInput, id: 'current', contextRevision: 6 } });
      assert.equal(stale.isError, true);
      assert.equal(decode(stale).error.code, 'CONTEXT_CONFLICT');
      assert.equal(calls.length, 1);
      const started = await client.callTool({ name: toolName, arguments: toolInput });
      assert.equal(started.isError, undefined);
      assert.deepEqual(decode(started), job);
      assert.deepEqual(calls[1], { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/discover/ai/jobs', body: { instruction: '', limit: 20, baseVersion: 4, idempotencyKey: 'find-1' }, actor: 'mcp' });
      const filtered = { ...toolInput, id: 'current', contextRevision: 7, instruction: '  找反例  ', tag: '想法', excludeTag: '概要', startDate: '2025-01-01', endDate: '2026-10-13', limit: 9 };
      assert.equal((await client.callTool({ name: toolName, arguments: filtered })).isError, undefined);
      assert.deepEqual(calls.slice(2), [
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/discover/ai/jobs', body: { instruction: '找反例', tag: '想法', excludeTag: '概要', startDate: '2025-01-01', endDate: '2026-10-13', limit: 9, baseVersion: 4, idempotencyKey: 'find-1' }, actor: 'mcp' },
      ]);
    });
  });
});

test('AI discovery MCP preserves forbidden and version-conflict errors without retry', async () => {
  for (const status of [403, 409]) await withService(() => ({ status, body: { error: { code: status === 403 ? 'AI_FORBIDDEN' : 'VERSION_CONFLICT', message: 'Review the current state.', details: { actualVersion: 9 } } } }), async (httpClient, calls) => {
    await withMcp(httpClient, async client => {
      const result = await client.callTool({ name: toolName, arguments: toolInput });
      assert.equal(result.isError, true);
      assert.deepEqual(decode(result).error, { code: status === 403 ? 'AI_FORBIDDEN' : 'VERSION_CONFLICT', message: 'Review the current state.', details: { actualVersion: 9 } });
      assert.equal(calls.length, 1);
    });
  });
});

test('CLI and MCP can inspect discovery results and choose candidates entirely through shared service endpoints', async () => {
  const completed = { ...job, status: 'succeeded', text: '找到一条反例。', discovery: { ...job.discovery, phase: 'ranking', workspaceVersion: 5, result: { terms: ['反例'], readCount: 1, omitted: [], possiblyLimited: false, ai: { summary: '找到一条反例。', recommendedCount: 1 } } } };
  const workspace = { id: 'w/一', version: 5, materialCandidates: [{ memo: { id: 'm/一', content: '完整反例' }, reason: '界定适用条件', relation: 'counterpoint', status: 'proposed' }] };
  const selected = { ...workspace, version: 6, materialCandidates: [{ ...workspace.materialCandidates[0], status: 'selected' }] };
  const change = { id: 2, entity: 'job', entityId: job.id, workspaceId: job.workspaceId, actor: 'cli', operation: 'succeeded' };
  await withService(request => ({ body: request.path.startsWith('/api/v1/jobs?') ? [completed] : request.path.startsWith('/api/v1/jobs/') ? completed : request.path.startsWith('/api/v1/changes') ? [change] : request.method === 'PATCH' ? selected : workspace }), async (httpClient, calls) => {
    const cliRead = await invoke(httpClient, ['job', 'get', job.id]);
    assert.deepEqual(JSON.parse(cliRead.stdout), completed);
    assert.deepEqual(JSON.parse((await invoke(httpClient, ['job', 'list', '--workspace', workspace.id])).stdout), [completed]);
    assert.deepEqual(JSON.parse((await invoke(httpClient, ['changes', 'list', '--after', '1'])).stdout), [change]);
    assert.deepEqual(JSON.parse((await invoke(httpClient, ['workspace', 'get', workspace.id])).stdout), workspace);
    const cliSelection = await invoke(httpClient, ['material', 'decide', workspace.id, '--memo', 'm/一', '--status', 'selected', '--base-version', '5']);
    assert.deepEqual(JSON.parse(cliSelection.stdout), selected);
    await withMcp(httpClient, async client => {
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_job_get', arguments: { id: job.id } })), completed);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_job_list', arguments: { workspaceId: workspace.id } })), [completed]);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_changes_list', arguments: { after: 1 } })), [change]);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_workspace_get', arguments: { id: workspace.id } })), workspace);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_material_decide', arguments: { id: workspace.id, memoId: 'm/一', status: 'selected', baseVersion: 5 } })), selected);
    });
    assert.equal(calls.length, 10);
    assert.ok(calls.every(call => call.path !== '/api/v1/context'));
    for (const call of calls.filter(item => item.method === 'PATCH')) {
      assert.equal(call.path, '/api/v1/workspaces/w%2F%E4%B8%80/candidates/m%2F%E4%B8%80');
      assert.deepEqual(call.body, { status: 'selected', baseVersion: 5 });
    }
  });
});
