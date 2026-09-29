import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli, WorkbenchClient } from '../cli/workbench.js';

type Request = { method: string; path: string; body: unknown };
async function withService(respond: (request: Request) => { status?: number; body: unknown }, run: (client: WorkbenchClient, calls: Request[]) => Promise<void>) {
  const calls: Request[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = { method: req.method!, path: req.url!, body: body ? JSON.parse(body) : undefined };
    calls.push(request);
    const response = respond(request);
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(new WorkbenchClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), calls); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function invoke(client: WorkbenchClient, args: string[], input = '') {
  let stdout = '', stderr = '';
  const code = await runCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, stdin: async () => input }, client);
  return { code, stdout, stderr };
}

test('current resolves the active Web selection once and preserves draft summary/version', async () => {
  let selection = 'note/一';
  await withService(request => {
    if (request.path === '/api/v1/context') {
      const selected = selection;
      selection = 'other-workspace';
      return { body: { workspaceId: selected, revision: 7, view: 'draft' } };
    }
    return { body: { id: 'note/一', version: 5 } };
  }, async (client, calls) => {
    const result = await invoke(client, ['draft', 'update', 'current', '--stdin', '--summary', '补充目标读者', '--base-version', '4', '--context-revision', '7', '--json'], '# 新稿\n保留原文。');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v1/context', body: undefined },
      { method: 'PATCH', path: '/api/v1/workspaces/note%2F%E4%B8%80/draft', body: { draft: '# 新稿\n保留原文。', summary: '补充目标读者', baseVersion: 4 } },
    ]);
  });
});

test('current has a useful machine-readable error when the Web has no selected workspace', async () => {
  await withService(() => ({ body: { workspaceId: null, revision: 0, view: 'note' } }), async (client, calls) => {
    const result = await invoke(client, ['workspace', 'get', 'current']);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'NO_ACTIVE_WORKSPACE');
    assert.equal(result.stdout, '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'GET');
  });
});

test('current mutations require the observed context revision and reject a different selection even at the same content version', async () => {
  await withService(() => ({ body: { workspaceId: 'workspace-b', revision: 2, view: 'note', workspace: { id: 'workspace-b', version: 1 } } }), async (client, calls) => {
    const command = ['draft', 'update', 'current', '--text', 'draft for workspace-a', '--base-version', '1'];
    const missing = await invoke(client, command);
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stderr).error.code, 'CONTEXT_REVISION_REQUIRED');
    assert.equal(calls.length, 0);
    const changed = await invoke(client, [...command, '--context-revision', '1']);
    assert.equal(changed.code, 3);
    assert.equal(JSON.parse(changed.stderr).error.code, 'CONTEXT_CONFLICT');
    assert.deepEqual(calls, [{ method: 'GET', path: '/api/v1/context', body: undefined }]);
  });
});

test('context uses an independent nonnegative revision and surfaces selection conflicts', async () => {
  await withService(() => ({ status: 409, body: { error: { code: 'CONTEXT_CONFLICT', message: 'Selection changed.', details: { actualRevision: 9 } } } }), async (client, calls) => {
    const result = await invoke(client, ['context', 'set', '--workspace', 'none', '--view', 'note', '--base-revision', '0', '--json']);
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stderr).error.details.actualRevision, 9);
    assert.deepEqual(calls, [{ method: 'PUT', path: '/api/v1/context', body: { workspaceId: null, view: 'note', baseRevision: 0 } }]);
    for (const extra of [['--view', 'chat', '--base-revision', '1'], ['--view', 'note', '--base-revision', '-1'], ['--view', 'note']]) {
      assert.equal((await invoke(client, ['context', 'set', '--workspace', 'w1', ...extra])).code, 2);
    }
    assert.equal(calls.length, 1);
  });
});

test('material recommendations and decisions retain human context with explicit versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flomo-workflow-cli-'));
  try {
    const proposals = join(directory, 'materials.json');
    const decision = join(directory, 'decision.json');
    await writeFile(proposals, JSON.stringify([{ memoId: 'm/1', reason: '提供无编程背景科研的案例', relation: 'example' }]));
    await writeFile(decision, JSON.stringify({ question: '主要面向谁？', options: ['研究生', '独立研究者'] }));
    await withService(() => ({ body: { id: 'w1', version: 6 } }), async (client, calls) => {
      const commands = [
        ['workspace', 'goal', 'w1', '--text', '明确账号的目标读者', '--base-version', '1'],
        ['material', 'propose', 'w1', '--file', proposals, '--base-version', '2'],
        ['material', 'decide', 'w1', '--memo', 'm/1', '--status', 'selected', '--base-version', '3'],
        ['decision', 'add', 'w1', '--file', decision, '--base-version', '4'],
        ['decision', 'answer', 'w1', '--decision', 'd/1', '--stdin', '--base-version', '5'],
        ['draft', 'history', 'w1'],
      ];
      for (const args of commands) { const result = await invoke(client, args, '没有编程经验的研究生'); assert.equal(result.code, 0, result.stderr); }
      assert.deepEqual(calls, [
        { method: 'PATCH', path: '/api/v1/workspaces/w1/goal', body: { goal: '明确账号的目标读者', baseVersion: 1 } },
        { method: 'POST', path: '/api/v1/workspaces/w1/candidates', body: { items: [{ memoId: 'm/1', reason: '提供无编程背景科研的案例', relation: 'example' }], baseVersion: 2 } },
        { method: 'PATCH', path: '/api/v1/workspaces/w1/candidates/m%2F1', body: { status: 'selected', baseVersion: 3 } },
        { method: 'POST', path: '/api/v1/workspaces/w1/decisions', body: { question: '主要面向谁？', options: ['研究生', '独立研究者'], baseVersion: 4 } },
        { method: 'PATCH', path: '/api/v1/workspaces/w1/decisions/d%2F1', body: { answer: '没有编程经验的研究生', baseVersion: 5 } },
        { method: 'GET', path: '/api/v1/workspaces/w1/revisions', body: undefined },
      ]);
      await writeFile(proposals, JSON.stringify([{ memoId: 'm1', relation: 'example' }]));
      await writeFile(decision, JSON.stringify({ question: 'Bad version', baseVersion: 50 }));
      const invalid = [
        ['material', 'propose', 'current', '--file', proposals, '--base-version', '1'],
        ['material', 'decide', 'current', '--memo', 'm1', '--status', 'unknown', '--base-version', '1'],
        ['decision', 'add', 'current', '--file', decision, '--base-version', '1'],
      ];
      for (const args of invalid) assert.equal((await invoke(client, args)).code, 2);
      assert.equal(calls.length, 6, 'invalid inputs must be rejected before resolving or modifying the active workspace');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MCP exposes shared context, recommendations, decisions and current-workspace updates', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createWorkbenchMcpServer } = await import('../mcp-server/workbench.js');
  await withService(request => ({ body: request.path === '/api/v1/context' ? { workspaceId: 'w1', revision: 8, view: 'materials' } : { version: 5 } }), async (httpClient, calls) => {
    const server = createWorkbenchMcpServer(new WorkbenchClient(httpClient.baseUrl, 'mcp'));
    const client = new Client({ name: 'workflow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const inventory = await client.listTools();
      for (const name of ['workbench_context_get', 'workbench_context_set', 'workbench_workspace_goal', 'workbench_materials_propose', 'workbench_material_decide', 'workbench_decision_add', 'workbench_decision_answer', 'workbench_draft_history']) {
        assert.ok(inventory.tools.some(tool => tool.name === name), `Missing ${name}`);
      }
      const arguments_ = { id: 'current', items: [{ memoId: 'm1', reason: '质疑原来的假设', relation: 'counterpoint' }], baseVersion: 4 };
      const missing = await client.callTool({ name: 'workbench_materials_propose', arguments: arguments_ });
      assert.equal(missing.isError, true);
      assert.equal(JSON.parse((missing.content as { text: string }[])[0]!.text).error.code, 'CONTEXT_REVISION_REQUIRED');
      assert.equal(calls.length, 0);
      const response = await client.callTool({ name: 'workbench_materials_propose', arguments: { ...arguments_, contextRevision: 8 } });
      assert.equal(response.isError, undefined);
      assert.deepEqual(calls, [
        { method: 'GET', path: '/api/v1/context', body: undefined },
        { method: 'POST', path: '/api/v1/workspaces/w1/candidates', body: { items: [{ memoId: 'm1', reason: '质疑原来的假设', relation: 'counterpoint' }], baseVersion: 4 } },
      ]);
    } finally { await client.close(); await server.close(); }
  });
});
