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
async function withFile(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-note-draft-cli-'));
  const path = join(directory, 'note.json');
  try { await writeFile(path, JSON.stringify(note)); await run(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const note = { title: '需求验证能力优势', content: '独立判断。\n\n来源 https://example.com/a_b?x=1&y=2\n#想法' };

test('note-draft CLI preserves content and basis, encodes IDs, and publishes only on an explicit command', async () => {
  await withFile(async path => {
    const workspace = { id: 'w/一', version: 5, noteDrafts: [{ id: 'd/一', ...note, status: 'draft' }] };
    await withService(() => ({ body: workspace }), async (client, calls) => {
      const create = await invoke(client, ['note-draft', 'create', 'w/一', '--file', path, '--basis', 'a/一', '--base-version', '4', '--idempotency-key', 'create-1']);
      assert.equal(create.code, 0, create.stderr);
      assert.deepEqual(JSON.parse(create.stdout), workspace);
      assert.equal((await invoke(client, ['workspace', 'get', 'w/一'])).code, 0);
      const update = await invoke(client, ['note-draft', 'update', 'w/一', '--note-draft', 'd/一', '--file', path, '--base-version', '5']);
      assert.equal(update.code, 0, update.stderr);
      assert.ok(calls.every(call => !call.path.endsWith('/publish')));
      const publish = await invoke(client, ['note-draft', 'publish', 'w/一', '--note-draft', 'd/一', '--base-version', '6', '--idempotency-key', 'publish-1']);
      assert.equal(publish.code, 0, publish.stderr);
      const base = '/api/v1/workspaces/w%2F%E4%B8%80';
      assert.deepEqual(calls, [
        { method: 'POST', path: `${base}/note-drafts`, body: { ...note, baseVersion: 4, idempotencyKey: 'create-1', originAnalysisId: 'a/一' }, actor: 'cli' },
        { method: 'GET', path: base, body: undefined, actor: 'cli' },
        { method: 'PATCH', path: `${base}/note-drafts/d%2F%E4%B8%80`, body: { ...note, baseVersion: 5 }, actor: 'cli' },
        { method: 'POST', path: `${base}/note-drafts/d%2F%E4%B8%80/publish`, body: { baseVersion: 6, idempotencyKey: 'publish-1' }, actor: 'cli' },
      ]);
    });
  });
});

test('note-draft CLI rejects invalid files and missing arguments before HTTP', async () => {
  await withFile(async path => {
    await withService(() => ({ body: {} }), async (client, calls) => {
      const create = ['note-draft', 'create', 'current', '--file', path, '--base-version', '1', '--idempotency-key', 'k'];
      for (const value of [[], null, { ...note, baseVersion: 9 }, { ...note, idempotencyKey: 'hidden' }, { ...note, originAnalysisId: 'hidden' }, { title: 4 }, { content: ['body'] }, { title: 'a'.repeat(201) }, { content: 'a'.repeat(100001) }]) {
        await writeFile(path, JSON.stringify(value));
        assert.equal((await invoke(client, create)).code, 2, JSON.stringify(value).slice(0, 100));
      }
      await writeFile(path, JSON.stringify(note));
      for (const args of [
        ['note-draft', 'create', '', '--file', path, '--base-version', '1', '--idempotency-key', 'k'],
        ['note-draft', 'create', 'w1', '--base-version', '1', '--idempotency-key', 'k'],
        ['note-draft', 'create', 'w1', '--file', path, '--base-version', '1'],
        ['note-draft', 'create', 'w1', '--file', path, '--base-version', '1', '--idempotency-key', 'k', '--basis', ''],
        ['note-draft', 'update', 'w1', '--file', path, '--base-version', '1'],
        ['note-draft', 'update', 'w1', '--note-draft', '  ', '--file', path, '--base-version', '1'],
        ['note-draft', 'update', 'w1', '--note-draft', 'd1', '--file', path, '--base-version', '0'],
        ['note-draft', 'publish', 'w1', '--base-version', '1', '--idempotency-key', 'k'],
        ['note-draft', 'publish', 'w1', '--note-draft', 'd1', '--base-version', '1', '--idempotency-key', 'x'.repeat(201)],
      ]) assert.equal((await invoke(client, args)).code, 2, JSON.stringify(args));
      await writeFile(path, '{}');
      assert.equal((await invoke(client, ['note-draft', 'update', 'w1', '--note-draft', 'd1', '--file', path, '--base-version', '1'])).code, 2);
      assert.equal(calls.length, 0);
    });
  });
});

test('note-draft mutations guard current context and return version conflicts without retrying', async () => {
  await withFile(async path => {
    await withService(request => request.path === '/api/v1/context'
      ? { body: { workspaceId: 'w/一', revision: 7 } }
      : { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'Re-read and review.', details: { actualVersion: 10 } } } }, async (client, calls) => {
      const commands = [
        ['note-draft', 'create', 'current', '--file', path, '--base-version', '1', '--idempotency-key', 'create'],
        ['note-draft', 'update', 'current', '--note-draft', 'd/一', '--file', path, '--base-version', '1'],
        ['note-draft', 'publish', 'current', '--note-draft', 'd/一', '--base-version', '1', '--idempotency-key', 'publish'],
      ];
      for (const args of commands) {
        const result = await invoke(client, args);
        assert.equal(result.code, 2);
        assert.equal(JSON.parse(result.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
      }
      assert.equal(calls.length, 0);
      for (const args of commands) {
        const result = await invoke(client, [...args, '--context-revision', '6']);
        assert.equal(result.code, 3);
        assert.equal(JSON.parse(result.stderr).error.code, 'CONTEXT_CONFLICT');
      }
      assert.equal(calls.length, 3);
      assert.ok(calls.every(call => call.path === '/api/v1/context'));
      const conflict = await invoke(client, [...commands[2]!, '--context-revision', '7']);
      assert.equal(conflict.code, 3);
      assert.equal(conflict.stdout, '');
      assert.equal(JSON.parse(conflict.stderr).error.details.actualVersion, 10);
      assert.deepEqual(calls.slice(-2).map(call => call.path), ['/api/v1/context', '/api/v1/workspaces/w%2F%E4%B8%80/note-drafts/d%2F%E4%B8%80/publish']);
      assert.equal(calls.length, 5, 'must resolve once and never retry on another version');
    });
  });
});

test('note-draft MCP shares schemas, context protection and local-save versus publication routing', async () => {
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w1', revision: 3 } : { version: 5, noteDrafts: [] } }), async (httpClient, calls) => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'note-draft-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      const requests = [
        { name: 'workbench_note_draft_create', arguments: { id: 'w1', ...note, originAnalysisId: 'a/一', baseVersion: 1, idempotencyKey: 'create' } },
        { name: 'workbench_note_draft_update', arguments: { id: 'w1', noteDraftId: 'd/一', ...note, baseVersion: 2 } },
        { name: 'workbench_note_draft_publish', arguments: { id: 'w1', noteDraftId: 'd/一', baseVersion: 3, idempotencyKey: 'publish' } },
      ];
      for (const request of requests) {
        assert.ok(inventory.tools.some(tool => tool.name === request.name));
        const missing = await client.callTool({ ...request, arguments: { ...request.arguments, id: 'current' } });
        assert.equal(missing.isError, true);
        assert.equal(JSON.parse((missing.content as { text: string }[])[0]!.text).error.code, 'CONTEXT_REVISION_REQUIRED');
      }
      const invalid = await client.callTool({ name: 'workbench_note_draft_update', arguments: { id: 'current', noteDraftId: 'd1', content: 'no title', baseVersion: 1, contextRevision: 3 } });
      assert.equal(invalid.isError, true);
      assert.equal(calls.length, 0);
      for (const request of requests.slice(0, 2)) assert.equal((await client.callTool(request)).isError, undefined);
      assert.ok(calls.every(call => !call.path.endsWith('/publish')));
      assert.equal((await client.callTool({ ...requests[2]!, arguments: { ...requests[2]!.arguments, id: 'current', contextRevision: 3 } })).isError, undefined);
      assert.deepEqual(calls, [
        { method: 'POST', path: '/api/v1/workspaces/w1/note-drafts', body: { ...note, originAnalysisId: 'a/一', baseVersion: 1, idempotencyKey: 'create' }, actor: 'mcp' },
        { method: 'PATCH', path: '/api/v1/workspaces/w1/note-drafts/d%2F%E4%B8%80', body: { ...note, baseVersion: 2 }, actor: 'mcp' },
        { method: 'GET', path: '/api/v1/context', body: undefined, actor: 'mcp' },
        { method: 'POST', path: '/api/v1/workspaces/w1/note-drafts/d%2F%E4%B8%80/publish', body: { baseVersion: 3, idempotencyKey: 'publish' }, actor: 'mcp' },
      ]);
    } finally { await client.close(); await server.close(); }
  });
});
