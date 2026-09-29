import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { runCli, WorkbenchClient } from '../cli/workbench.js';
import type { Change } from '../shared/contracts.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;
async function withServer(handler: Handler, run: (client: WorkbenchClient) => Promise<void>) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    handler(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(new WorkbenchClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
async function invoke(client: WorkbenchClient, args: string[], stdin = '') {
  let stdout = '', stderr = '';
  const code = await runCli(args, {
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, stdin: async () => stdin,
  }, client);
  return { code, stdout, stderr };
}
const change = (id: number): Change => ({ id, entity: 'workspace', entityId: 'w1', kind: 'draft.updated', actor: 'cli', version: id, createdAt: '2026-09-29T00:00:00Z' });

test('memo search preserves nested Unicode tags and URL query encoding; JSON stdout stays clean', async () => {
  await withServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.pathname, '/api/v1/memos');
    assert.equal(url.searchParams.get('tag'), '待编/想法');
    assert.equal(url.searchParams.get('q'), 'AI & 科研');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(req.headers['x-workbench-actor'], 'cli');
    json(res, { memos: [], scope: 'remote-search', possiblyLimited: true });
  }, async client => {
    const result = await invoke(client, ['memo', 'list', '--tag', '待编/想法', '--query', 'AI & 科研', '--limit', '20', '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).possiblyLimited, true);
  });
});

test('draft stdin write preserves exact body and sends observed version; conflict is machine readable', async () => {
  await withServer((req, res, body) => {
    assert.equal(req.method, 'PATCH');
    assert.equal(req.url, '/api/v1/workspaces/w%2F1/draft');
    assert.deepEqual(body, { draft: '# 我的草稿\n\n`code` 和 $literal\n', baseVersion: 3 });
    json(res, { error: { code: 'VERSION_CONFLICT', message: 'Draft changed in another client.', details: { actualVersion: 4 } } }, 409);
  }, async client => {
    const result = await invoke(client, ['draft', 'update', 'w/1', '--stdin', '--base-version', '3', '--json'], '# 我的草稿\n\n`code` 和 $literal\n');
    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.details.actualVersion, 4);
  });
});

test('publish requires an explicit idempotency key and valid expected version before contacting service', async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; json(res, {}); }, async client => {
    for (const args of [
      ['draft', 'publish', 'w1', '--expected-version', '4'],
      ['draft', 'publish', 'w1', '--expected-version', '4oops', '--idempotency-key', 'key'],
      ['draft', 'publish', 'w1', '--expected-version', '0', '--idempotency-key', 'key'],
      ['draft', 'publish', 'w1', '--expected-version', '4', '--idempotency-key', 'key', '--memo', 'other'],
    ]) {
      const result = await invoke(client, args);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
    }
    assert.equal(requests, 0);
  });
});

test('publish retries preserve exact idempotency payload and job can be reconciled', async () => {
  const received: unknown[] = [];
  await withServer((req, res, body) => {
    received.push({ method: req.method, path: req.url, body });
    json(res, { id: 'j1', status: 'uncertain' });
  }, async client => {
    const args = ['draft', 'publish', 'w1', '--expected-version', '5', '--idempotency-key', 'publish-w1-v5', '--json'];
    assert.equal((await invoke(client, args)).code, 0);
    assert.equal((await invoke(client, args)).code, 0);
    assert.deepEqual(received[0], received[1]);
    assert.deepEqual(received[0], { method: 'POST', path: '/api/v1/workspaces/w1/publish', body: { baseVersion: 5, idempotencyKey: 'publish-w1-v5' } });
    await invoke(client, ['job', 'reconcile', 'j1']);
    assert.deepEqual(received[2], { method: 'POST', path: '/api/v1/jobs/j1/reconcile', body: {} });
  });
});

test('invalid body source, role and unsupported options are validation errors', async () => {
  await withServer((_req, res) => { assert.fail('invalid inputs must not cause HTTP calls'); json(res, {}); }, async client => {
    for (const args of [
      ['draft', 'update', 'w1', '--text', 'body', '--stdin', '--base-version', '1'],
      ['message', 'add', 'w1', '--role', 'system', '--text', 'body', '--base-version', '1'],
      ['workspace', 'list', '--memo', 'id'],
      ['workspace', 'create'],
      ['material', 'set', 'w1', '--base-version', '1'],
      ['changes', 'list', '--after', '-1'],
      ['memo', 'list', '--unexpected'],
    ]) assert.equal((await invoke(client, args)).code, 2);
  });
});

test('offline service has a stable exit code and does not expose connection details', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const result = await invoke(new WorkbenchClient(`http://127.0.0.1:${port}`), ['service', 'status', '--json']);
  assert.equal(result.code, 4);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'SERVICE_OFFLINE');
  assert.ok(!result.stderr.includes(String(port)));
});

test('watch catches up across the initial subscription gap and reconnects without duplicate changes', async () => {
  let connections = 0;
  let listCalls = 0;
  const cursors: number[] = [];
  await withServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const after = Number(url.searchParams.get('after'));
    if (url.pathname.endsWith('/changes')) {
      listCalls++;
      const available = listCalls === 1 ? [change(1)] : connections === 1 ? [change(1), change(2), change(3)] : [change(1), change(2), change(3), change(4)];
      json(res, available.filter(value => value.id > after));
    } else {
      connections++;
      cursors.push(after);
      assert.equal(req.headers['last-event-id'], String(after));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Split CRLF across writes to exercise streaming rather than line-based assumptions.
      res.write('event: ready\r');
      setTimeout(() => {
        res.write('\ndata: {}\r\n\r\n');
        res.write(`id: 3\nevent: change\ndata: ${JSON.stringify(change(3))}\n\n`);
        res.end();
      }, 10);
    }
  }, async client => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const seen: number[] = [];
    try {
      for await (const value of client.watch(0, controller.signal)) {
        seen.push(value.id);
        if (value.id === 4) { controller.abort(); break; }
      }
    } finally { clearTimeout(timeout); controller.abort(); }
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.deepEqual(cursors, [1, 3]);
  });
});

test('watch drains historical pagination before starting live notifications', async () => {
  const requested: number[] = [];
  await withServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.ok(url.pathname.endsWith('/changes'));
    const after = Number(url.searchParams.get('after'));
    requested.push(after);
    json(res, Array.from({ length: Math.min(1000, 1002 - after) }, (_, index) => change(after + index + 1)));
  }, async client => {
    const controller = new AbortController();
    const seen: number[] = [];
    for await (const value of client.watch(0, controller.signal)) {
      seen.push(value.id);
      if (value.id === 1002) { controller.abort(); break; }
    }
    assert.equal(seen.length, 1002);
    assert.deepEqual(requested, [0, 1000]);
  });
});

test('MCP tools use the same HTTP contract, mark the actor and preserve conflict errors', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createWorkbenchMcpServer } = await import('../mcp-server/workbench.js');
  await withServer((req, res, body) => {
    assert.equal(req.headers['x-workbench-actor'], 'mcp');
    assert.equal(req.url, '/api/v1/workspaces/w1/draft');
    assert.deepEqual(body, { draft: 'MCP draft', baseVersion: 2 });
    json(res, { error: { code: 'VERSION_CONFLICT', message: 'Re-read the workspace.', details: { currentVersion: 3 } } }, 409);
  }, async httpClient => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      assert.ok(inventory.tools.some(tool => tool.name === 'workbench_draft_publish'));
      assert.ok(inventory.tools.some(tool => tool.name === 'workbench_changes_wait'));
      const response = await client.callTool({ name: 'workbench_draft_update', arguments: { id: 'w1', draft: 'MCP draft', baseVersion: 2 } });
      assert.equal(response.isError, true);
      const content = response.content as { type: string; text: string }[];
      assert.equal(JSON.parse(content[0]!.text).error.code, 'VERSION_CONFLICT');
    } finally { await client.close(); await server.close(); }
  });
});

test('abandoning an uncertain publish requires acknowledgement and forwards the current workspace version', async () => {
  let requests = 0;
  await withServer((req, res, body) => {
    requests++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/jobs/j%2F1/abandon');
    assert.deepEqual(body, { baseVersion: 8, acknowledge: true });
    json(res, { id: 'j/1', status: 'failed' });
  }, async client => {
    const unacknowledged = await invoke(client, ['job', 'abandon', 'j/1', '--base-version', '8']);
    assert.equal(unacknowledged.code, 2);
    assert.equal(JSON.parse(unacknowledged.stderr).error.code, 'ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(requests, 0);
    const invalidVersion = await invoke(client, ['job', 'abandon', 'j/1', '--acknowledge']);
    assert.equal(invalidVersion.code, 2);
    assert.equal(requests, 0);
    const result = await invoke(client, ['job', 'abandon', 'j/1', '--base-version', '8', '--acknowledge', '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert.equal(requests, 1);
  });
});
