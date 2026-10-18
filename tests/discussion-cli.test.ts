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
const decode = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as { text: string }[])[0]!.text);
const workspace = { id: 'w/讨论', version: 5, draft: '未变的草稿', materials: [{ memo: { id: 'm2', content: '已刷新的正文' } }], collectorMaterials: [], messages: [{ role: 'assistant', content: '旧回答' }] };

test('discussion CLI refreshes all discussion inputs with an explicit version and no Web selection', async () => {
  await withService(() => ({ body: workspace }), async (client, calls) => {
    const result = await invoke(client, ['discussion', 'refresh', workspace.id, '--base-version', '4', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), workspace);
    assert.deepEqual(calls, [{ method: 'POST', path: '/api/v1/workspaces/w%2F%E8%AE%A8%E8%AE%BA/discussion/refresh', body: { baseVersion: 4 }, actor: 'cli' }]);
    const help = await invoke(client, ['--help']);
    assert.match(help.stdout, /discussion refresh ID --base-version N/);
    assert.match(help.stdout, /note\|materials\|discussion\|writing\|draft/);
  });
});

test('discussion CLI guards current selection and resolves it once before refreshing', async () => {
  let contextReads = 0;
  await withService(request => {
    if (request.path === '/api/v1/context') return { body: { workspaceId: ++contextReads === 1 ? workspace.id : 'other', revision: 7, view: 'discussion' } };
    return { body: workspace };
  }, async (client, calls) => {
    const missing = await invoke(client, ['discussion', 'refresh', 'current', '--base-version', '4']);
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
    assert.equal(calls.length, 0);
    const result = await invoke(client, ['discussion', 'refresh', 'current', '--base-version', '4', '--context-revision', '7', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E8%AE%A8%E8%AE%BA/discussion/refresh', body: { baseVersion: 4 }, actor: 'cli' },
    ]);
    const stale = await invoke(client, ['discussion', 'refresh', 'current', '--base-version', '4', '--context-revision', '6']);
    assert.equal(stale.code, 3);
    assert.equal(JSON.parse(stale.stderr).error.code, 'CONTEXT_CONFLICT');
    assert.equal(calls.at(-1)!.method, 'GET');
    assert.equal(calls.length, 3);
  });
});

test('discussion CLI validates refresh arguments before reading context or writing', async () => {
  await withService(() => ({ body: workspace }), async (client, calls) => {
    const requests = [
      ['discussion', 'refresh', 'current'],
      ['discussion', 'refresh', '', '--base-version', '4'],
      ...['0', '-1', '1.5', 'text', '9007199254740992'].map(version => ['discussion', 'refresh', 'current', '--base-version', version, '--context-revision', '7']),
      ['discussion', 'refresh', 'current', '--base-version', '4', '--context-revision', '-1'],
      ['discussion', 'refresh', 'current', '--base-version', '4', '--text', 'unexpected'],
    ];
    for (const request of requests) assert.equal((await invoke(client, request)).code, 2);
    assert.deepEqual(calls, []);
  });
});

test('discussion CLI and MCP preserve refresh failures without retries or follow-up writes', async () => {
  for (const failure of [
    { status: 409, code: 'VERSION_CONFLICT', details: { actualVersion: 8 } },
    { status: 503, code: 'COLLECTOR_UNAVAILABLE', details: { articleId: 'a1' } },
  ]) await withService(() => ({ status: failure.status, body: { error: { code: failure.code, message: 'Re-read the current discussion inputs.', details: failure.details } } }), async (httpClient, calls) => {
    const result = await invoke(httpClient, ['discussion', 'refresh', 'w1', '--base-version', '4']);
    assert.equal(result.code, failure.status === 409 ? 3 : 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).error.details, failure.details);
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'discussion-failure-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const failed = await client.callTool({ name: 'workbench_discussion_refresh', arguments: { id: 'w1', baseVersion: 4 } });
      assert.equal(failed.isError, true);
      assert.deepEqual(decode(failed).error, JSON.parse(result.stderr).error);
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => call.method === 'POST' && call.path.endsWith('/discussion/refresh')));
    } finally { await client.close(); await server.close(); }
  });
});

test('discussion view can be selected using CLI context revision', async () => {
  const context = { workspaceId: workspace.id, view: 'discussion', revision: 8 };
  await withService(() => ({ body: context }), async (client, calls) => {
    const result = await invoke(client, ['context', 'set', '--workspace', workspace.id, '--view', 'discussion', '--base-revision', '7', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), context);
    assert.deepEqual(calls, [{ method: 'PUT', path: '/api/v1/context', body: { workspaceId: workspace.id, view: 'discussion', baseRevision: 7 }, actor: 'cli' }]);
  });
});

test('discussion MCP exposes the refresh contract, new view and input-freshness boundaries', async () => {
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: workspace.id, revision: 7, view: 'discussion' } : workspace }), async (httpClient, calls) => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'discussion-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      const tools = Object.fromEntries(inventory.tools.map(tool => [tool.name, tool]));
      const refresh = tools.workbench_discussion_refresh!;
      assert.deepEqual(new Set(refresh.inputSchema.required), new Set(['id', 'baseVersion']));
      assert.match(refresh.description!, /all snapshots together/);
      assert.match(refresh.description!, /older replies never regenerate automatically/);
      assert.match(tools.workbench_message_add!.description!, /unknown generation freshness/);
      assert.ok((tools.workbench_context_set!.inputSchema.properties!.view as { enum: string[] }).enum.includes('discussion'));
      const missing = await client.callTool({ name: refresh.name, arguments: { id: 'current', baseVersion: 4 } });
      assert.equal(decode(missing).error.code, 'CONTEXT_REVISION_REQUIRED');
      for (const invalid of [{ baseVersion: 0 }, { baseVersion: 1.5 }, { baseVersion: 4, contextRevision: -1 }]) {
        assert.equal((await client.callTool({ name: refresh.name, arguments: { id: 'current', ...invalid } })).isError, true);
      }
      assert.equal(calls.length, 0);
      const stale = await client.callTool({ name: refresh.name, arguments: { id: 'current', baseVersion: 4, contextRevision: 6 } });
      assert.equal(decode(stale).error.code, 'CONTEXT_CONFLICT');
      assert.equal(calls.length, 1);
      calls.length = 0;
      const current = await client.callTool({ name: refresh.name, arguments: { id: 'current', baseVersion: 4, contextRevision: 7 } });
      assert.deepEqual(decode(current), workspace);
      const explicit = await client.callTool({ name: refresh.name, arguments: { id: workspace.id, baseVersion: 5 } });
      assert.deepEqual(decode(explicit), workspace);
      assert.deepEqual(calls, [
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w%2F%E8%AE%A8%E8%AE%BA/discussion/refresh', body: { baseVersion: 4 }, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w%2F%E8%AE%A8%E8%AE%BA/discussion/refresh', body: { baseVersion: 5 }, actor: 'mcp' },
      ]);
    } finally { await client.close(); await server.close(); }
  });
});
