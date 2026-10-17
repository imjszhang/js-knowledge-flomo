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
  const client = new Client({ name: 'note-link-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); await run(client); }
  finally { await client.close(); await server.close(); }
}
const previewHash = 'a'.repeat(64);
const input = { targetMemoId: 'memo_2', direction: 'outgoing', relation: 'background', reason: '', baseVersion: 4 };
const preview = { workspaceId: 'w/一', sourceMemo: { id: 'memo_1', content: '原笔记' }, targetMemo: { id: 'memo_2', content: '目标笔记' }, input, previewHash, steps: [{ memoId: 'memo_1', linkedMemoId: 'memo_2', before: { id: 'memo_1', content: '原笔记' }, afterContent: '原笔记\n\n关联：目标笔记', alreadyLinked: false, status: 'pending' }] };
const job = { id: 'job/一', workspaceId: 'w/一', kind: 'link', status: 'running', link: { sourceMemoId: 'memo_1', input, previewHash, steps: preview.steps } };
const basicFlags = ['--memo', 'memo_2', '--base-version', '4'];
const createFlags = [...basicFlags, '--preview-hash', previewHash, '--idempotency-key', 'link-1'];
const decode = (response: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((response.content as { text: string }[])[0]!.text);

test('link CLI previews, submits the reviewed hash and lists saved jobs without a Web selection', async () => {
  await withService(request => ({ status: request.method === 'POST' && !request.path.endsWith('/preview') ? 202 : 200, body: request.method === 'GET' ? [job] : request.path.endsWith('/preview') ? preview : job }), async (client, calls) => {
    const inspected = await invoke(client, ['link', 'preview', 'w/一', ...basicFlags, '--json']);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.deepEqual(JSON.parse(inspected.stdout), preview);
    const created = await invoke(client, ['link', 'create', 'w/一', ...createFlags]);
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), job);
    assert.deepEqual(JSON.parse((await invoke(client, ['link', 'list', 'w/一'])).stdout), [job]);
    assert.deepEqual(calls, [
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links/preview', body: input, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links', body: { ...input, previewHash, idempotencyKey: 'link-1' }, actor: 'cli' },
      { method: 'GET', path: '/api/v1/workspaces/w%2F%E4%B8%80/links', body: undefined, actor: 'cli' },
    ]);
    const help = await invoke(client, ['--help']);
    assert.match(help.stdout, /link create requires the reviewed previewHash/);
    assert.match(help.stdout, /bidirectional explicitly updates both notes/);
    assert.match(help.stdout, /uncertain link must be verified/);
  });
});

test('link CLI resolves current once and transmits exact bidirectional preview choices', async () => {
  let selection = 'w/一';
  await withService(request => {
    if (request.path === '/api/v1/context') {
      const workspaceId = selection;
      selection = 'changed-after-read';
      return { body: { workspaceId, revision: 7 } };
    }
    return { body: preview };
  }, async (client, calls) => {
    const result = await invoke(client, ['link', 'preview', 'current', ...basicFlags, '--direction', 'bidirectional', '--relation', 'counterpoint', '--reason', '  提供相反例子  ', '--context-revision', '7']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'cli' },
      { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links/preview', body: { ...input, direction: 'bidirectional', relation: 'counterpoint', reason: '提供相反例子' }, actor: 'cli' },
    ]);
  });
});

test('link CLI rejects invalid parameters, missing preview hashes and unconfirmed current before writes', async () => {
  await withService(() => ({ body: { workspaceId: 'different', revision: 8 } }), async (client, calls) => {
    const invalid = [
      ['link', 'list', ''], ['link', 'list', 'w1', '--memo', 'memo_2'],
      ['link', 'preview', 'w1', '--base-version', '4'],
      ['link', 'preview', 'w1', '--memo', 'memo_2'],
      ['link', 'preview', 'w1', ...basicFlags, '--preview-hash', previewHash],
      ['link', 'create', 'w1', ...basicFlags, '--idempotency-key', 'link-1'],
      ['link', 'create', 'w1', ...basicFlags, '--preview-hash', previewHash],
      ...[['--direction', 'both'], ['--relation', 'similar'], ['--reason', 'x'.repeat(2001)], ['--memo', 'https://flomoapp.com/?memo_id=2'], ['--memo', ''], ['--memo', 'x'.repeat(501)], ['--base-version', '0'], ['--context-revision', '-1']].map(extra => ['link', 'preview', 'current', ...basicFlags, ...extra]),
      ...[['--preview-hash', 'bad-hash'], ['--preview-hash', 'A'.repeat(64)], ['--idempotency-key', ''], ['--idempotency-key', 'x'.repeat(201)]].map(extra => ['link', 'create', 'w1', ...createFlags, ...extra]),
    ];
    for (const args of invalid) assert.equal((await invoke(client, args)).code, 2, JSON.stringify(args));
    for (const action of ['preview', 'create']) {
      const flags = action === 'preview' ? basicFlags : createFlags;
      const missing = await invoke(client, ['link', action, 'current', ...flags]);
      assert.equal(missing.code, 2);
      assert.equal(JSON.parse(missing.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
    }
    assert.equal(calls.length, 0);
    const stale = await invoke(client, ['link', 'create', 'current', ...createFlags, '--context-revision', '7']);
    assert.equal(stale.code, 3);
    assert.equal(JSON.parse(stale.stderr).error.code, 'CONTEXT_CONFLICT');
    assert.deepEqual(calls.map(call => call.method), ['GET']);
  });
});

test('link MCP tools expose preview-first remote writes, guard current and match CLI transport', async () => {
  await withService(request => ({ status: request.path.endsWith('/links') && request.method === 'POST' ? 202 : 200, body: request.path === '/api/v1/context' ? { workspaceId: 'w/一', revision: 7 } : request.method === 'GET' ? [job] : request.path.endsWith('/preview') ? preview : job }), async (httpClient, calls) => {
    await withMcp(httpClient, async client => {
      const inventory = await client.listTools();
      const tools = Object.fromEntries(inventory.tools.filter(tool => tool.name.startsWith('workbench_link_')).map(tool => [tool.name, tool]));
      assert.equal(Object.keys(tools).length, 3);
      const createTool = tools.workbench_link_create!;
      assert.match(createTool.description!, /EXISTING remote flomo notes/);
      assert.match(createTool.description!, /Requires link_preview first/);
      assert.match(createTool.description!, /without an open page/);
      assert.deepEqual(new Set(createTool.inputSchema.required), new Set(['id', 'targetMemoId', 'baseVersion', 'previewHash', 'idempotencyKey']));
      assert.equal((tools.workbench_link_preview!.inputSchema.properties!.direction as { default: string }).default, 'outgoing');
      const bare = { id: 'w/一', targetMemoId: 'memo_2', baseVersion: 4 };
      for (const tool of ['workbench_link_preview', 'workbench_link_create']) {
        const args = tool.endsWith('_create') ? { ...bare, previewHash, idempotencyKey: 'link-1' } : bare;
        for (const extra of [{ direction: 'both' }, { relation: 'similar' }, { reason: 'x'.repeat(2001) }, { targetMemoId: 'https://flomoapp.com/mine' }, { baseVersion: 0 }, { contextRevision: -1 }]) {
          assert.equal((await client.callTool({ name: tool, arguments: { ...args, ...extra } })).isError, true);
        }
        const missingContext = await client.callTool({ name: tool, arguments: { ...args, id: 'current' } });
        assert.equal(decode(missingContext).error.code, 'CONTEXT_REVISION_REQUIRED');
      }
      assert.equal((await client.callTool({ name: 'workbench_link_create', arguments: { ...bare, idempotencyKey: 'link-1' } })).isError, true);
      assert.equal((await client.callTool({ name: 'workbench_link_create', arguments: { ...bare, previewHash: 'bad', idempotencyKey: 'link-1' } })).isError, true);
      assert.equal(calls.length, 0);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_link_preview', arguments: bare })), preview);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_link_create', arguments: { ...bare, previewHash, idempotencyKey: 'link-1' } })), job);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_link_list', arguments: { id: 'current' } })), [job]);
      assert.deepEqual(calls, [
        { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links/preview', body: input, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links', body: { ...input, previewHash, idempotencyKey: 'link-1' }, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/workspaces/w%2F%E4%B8%80/links', body: undefined, actor: 'mcp' },
      ]);
      const stale = await client.callTool({ name: 'workbench_link_create', arguments: { ...bare, id: 'current', contextRevision: 6, previewHash, idempotencyKey: 'link-1' } });
      assert.equal(decode(stale).error.code, 'CONTEXT_CONFLICT');
      const current = await client.callTool({ name: 'workbench_link_create', arguments: { ...bare, id: 'current', contextRevision: 7, direction: 'bidirectional', relation: 'example', reason: '  具体例子  ', previewHash, idempotencyKey: 'link-2' } });
      assert.equal(current.isError, undefined);
      assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/v1/workspaces/w%2F%E4%B8%80/links', body: { ...input, direction: 'bidirectional', relation: 'example', reason: '具体例子', previewHash, idempotencyKey: 'link-2' }, actor: 'mcp' });
    });
  });
});

test('link adapters preserve conflict errors and reconcile uncertain steps without issuing another create', async () => {
  const failure = { code: 'LINK_PREVIEW_STALE', message: 'Read a fresh preview.', details: { memoId: 'memo_2' } };
  const uncertain = { ...job, status: 'uncertain', link: { ...job.link, steps: [{ ...preview.steps[0], status: 'verified' }, { memoId: 'memo_2', linkedMemoId: 'memo_1', status: 'uncertain' }] } };
  await withService(request => request.path.endsWith('/links') ? { status: 409, body: { error: failure } } : { body: uncertain }, async (httpClient, calls) => {
    const failed = await invoke(httpClient, ['link', 'create', 'w/一', ...createFlags]);
    assert.equal(failed.code, 3);
    assert.deepEqual(JSON.parse(failed.stderr), { error: failure });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse((await invoke(httpClient, ['job', 'reconcile', job.id])).stdout), uncertain);
    await withMcp(httpClient, async client => {
      const failed = await client.callTool({ name: 'workbench_link_create', arguments: { id: 'w/一', ...input, previewHash, idempotencyKey: 'link-1' } });
      assert.equal(failed.isError, true);
      assert.deepEqual(decode(failed), { error: failure });
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_job_get', arguments: { id: job.id } })), uncertain);
      assert.deepEqual(decode(await client.callTool({ name: 'workbench_job_reconcile', arguments: { id: job.id } })), uncertain);
    });
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.filter(call => call.path.endsWith('/reconcile')), [
      { method: 'POST', path: '/api/v1/jobs/job%2F%E4%B8%80/reconcile', body: {}, actor: 'cli' },
      { method: 'POST', path: '/api/v1/jobs/job%2F%E4%B8%80/reconcile', body: {}, actor: 'mcp' },
    ]);
  });
});
