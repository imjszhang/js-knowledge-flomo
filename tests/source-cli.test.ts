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
const article = { id: 'article/原文', title: '收藏正文', sourceUrl: 'https://example.com/article?a=1&b=2', summary: '摘要', digest: '概要', updatedAt: '2026-09-29T00:00:00Z', content: '# 原文\n完整内容', contentTruncated: false };

test('source CLI reads exact matches and articles without changing workspace materials', async () => {
  const resolution = { configured: true, truncated: false, items: [{ url: article.sourceUrl, memoIds: ['m1'], status: 'matched', articles: [article] }] };
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w/一', revision: 3 } : request.path.endsWith('/sources') ? resolution : article }), async (client, calls) => {
    const resolved = await invoke(client, ['source', 'resolve', 'current', '--json']);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.deepEqual(JSON.parse(resolved.stdout), resolution);
    const fetched = await invoke(client, ['source', 'get', article.id, '--json']);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.deepEqual(JSON.parse(fetched.stdout), article);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'GET', path: '/api/v1/workspaces/w%2F%E4%B8%80/sources', body: undefined, actor: 'cli' },
      { method: 'GET', path: '/api/v1/sources/article%2F%E5%8E%9F%E6%96%87', body: undefined, actor: 'cli' },
    ]);
  });
});

test('source CLI attach and detach preserve observed versions and the resolved current workspace', async () => {
  let selection = 'w/一';
  await withService(request => {
    if (request.path === '/api/v1/context') {
      const workspaceId = selection;
      selection = 'another-workspace';
      return { body: { workspaceId, revision: 3 } };
    }
    return { body: { id: 'w/一', version: request.method === 'POST' ? 5 : 6, collectorMaterials: request.method === 'POST' ? [{ kind: 'collector', article, memoIds: ['m1'], fetchedAt: '2026-09-29T01:00:00Z' }] : [] } };
  }, async (client, calls) => {
    const attached = await invoke(client, ['source', 'attach', 'current', '--article', article.id, '--base-version', '4', '--context-revision', '3', '--json']);
    assert.equal(attached.code, 0, attached.stderr);
    assert.equal(JSON.parse(attached.stdout).collectorMaterials[0].article.content, article.content);
    const detached = await invoke(client, ['source', 'detach', 'w/一', '--article', article.id, '--base-version', '5', '--json']);
    assert.equal(detached.code, 0, detached.stderr);
    assert.deepEqual(JSON.parse(detached.stdout).collectorMaterials, []);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/sources', body: { articleId: article.id, baseVersion: 4 }, actor: 'cli' },
      { method: 'DELETE', path: '/api/v1/workspaces/w%2F%E4%B8%80/sources/article%2F%E5%8E%9F%E6%96%87', body: { baseVersion: 5 }, actor: 'cli' },
    ]);
  });
});

test('source CLI rejects invalid arguments and stale current selection before writing', async () => {
  await withService(() => ({ body: { workspaceId: 'different-workspace', revision: 8 } }), async (client, calls) => {
    for (const action of ['attach', 'detach']) {
      for (const options of [[], ['--article', ''], ['--article', 'a', '--base-version', '0'], ['--article', 'a'.repeat(501), '--base-version', '1'], ['--article', 'a', '--base-version', '1', '--context-revision', '-1']]) {
        const result = await invoke(client, ['source', action, 'current', ...options]);
        assert.equal(result.code, 2, result.stderr);
      }
      const missingRevision = await invoke(client, ['source', action, 'current', '--article', 'a', '--base-version', '1']);
      assert.equal(missingRevision.code, 2);
      assert.equal(JSON.parse(missingRevision.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
    }
    for (const args of [['source', 'get', ''], ['source', 'get', 'a'.repeat(501)], ['source', 'resolve', ''], ['source', 'attach', '', '--article', 'a', '--base-version', '1'], ['source', 'resolve', 'current', '--article', 'a']]) assert.equal((await invoke(client, args)).code, 2);
    assert.equal(calls.length, 0, 'invalid inputs must not even read the current context');
    const stale = await invoke(client, ['source', 'attach', 'current', '--article', 'a', '--base-version', '1', '--context-revision', '7']);
    assert.equal(stale.code, 3);
    assert.equal(JSON.parse(stale.stderr).error.code, 'CONTEXT_CONFLICT');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });
});

test('source CLI preserves service errors without retrying or refreshing a changed workspace', async () => {
  await withService(request => ({ status: request.method === 'GET' ? 503 : 409, body: { error: { code: request.method === 'GET' ? 'COLLECTOR_UNAVAILABLE' : 'VERSION_CONFLICT', message: 'Review current state.', details: { actualVersion: 9 } } } }), async (client, calls) => {
    const unavailable = await invoke(client, ['source', 'get', 'a']);
    assert.equal(unavailable.code, 1);
    assert.equal(JSON.parse(unavailable.stderr).error.code, 'COLLECTOR_UNAVAILABLE');
    const conflict = await invoke(client, ['source', 'attach', 'w1', '--article', 'a', '--base-version', '1']);
    assert.equal(conflict.code, 3);
    assert.equal(conflict.stdout, '');
    assert.equal(JSON.parse(conflict.stderr).error.details.actualVersion, 9);
    assert.equal(calls.length, 2);
  });
});

test('source MCP tools use shared HTTP contracts and enforce current-workspace guards', async () => {
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w1', revision: 3 } : request.path.endsWith('/sources') && request.method === 'GET' ? { configured: true, truncated: false, items: [] } : article }), async (httpClient, calls) => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'source-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      for (const action of ['resolve', 'get', 'attach', 'detach']) assert.ok(inventory.tools.some(tool => tool.name === `workbench_source_${action}`));
      for (const action of ['attach', 'detach']) {
        const missing = await client.callTool({ name: `workbench_source_${action}`, arguments: { id: 'current', articleId: article.id, baseVersion: 4 } });
        assert.equal(missing.isError, true);
        assert.equal(JSON.parse((missing.content as { text: string }[])[0]!.text).error.code, 'CONTEXT_REVISION_REQUIRED');
        const invalid = await client.callTool({ name: `workbench_source_${action}`, arguments: { id: 'current', articleId: '', baseVersion: 4, contextRevision: 3 } });
        assert.equal(invalid.isError, true);
      }
      assert.equal(calls.length, 0);
      const requests = [
        { name: 'workbench_source_resolve', arguments: { id: 'current' } },
        { name: 'workbench_source_get', arguments: { articleId: article.id } },
        { name: 'workbench_source_attach', arguments: { id: 'current', articleId: article.id, baseVersion: 4, contextRevision: 3 } },
        { name: 'workbench_source_detach', arguments: { id: 'w1', articleId: article.id, baseVersion: 5 } },
      ];
      for (const request of requests) assert.equal((await client.callTool(request)).isError, undefined);
      assert.deepEqual(calls, [
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/workspaces/w1/sources', body: undefined, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/sources/article%2F%E5%8E%9F%E6%96%87', body: undefined, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w1/sources', body: { articleId: article.id, baseVersion: 4 }, actor: 'mcp' },
        { method: 'DELETE', path: '/api/v1/workspaces/w1/sources/article%2F%E5%8E%9F%E6%96%87', body: { baseVersion: 5 }, actor: 'mcp' },
      ]);
    } finally { await client.close(); await server.close(); }
  });
});
