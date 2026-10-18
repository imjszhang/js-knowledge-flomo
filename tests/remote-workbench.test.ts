import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createRemoteWorkbenchApp } from '../server/remote-workbench.js';

const remoteUrl = 'http://10.8.0.5:8888/flomo';
const localHeaders = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };

function fixture(t: TestContext, handler: (request: Request, init?: RequestInit) => Response | Promise<Response>, url = remoteUrl) {
  const calls: Request[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, { ...init, duplex: 'half' } as RequestInit);
    calls.push(request);
    return handler(request, init);
  };
  const app = createRemoteWorkbenchApp({ remoteUrl: url, fetch: transport });
  t.after(() => app.close());
  return { app, calls };
}

test('remote relay preserves the remote base path, query and static response', async t => {
  const f = fixture(t, request => {
    assert.equal(request.method, 'GET');
    return new Response('export const title = "知识工作台";', {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    });
  }, `${remoteUrl}/`);
  const response = await f.app.inject({ method: 'GET', url: '/assets/app.js?v=2&workspace=a%2Fb', headers: localHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(f.calls[0].url, `${remoteUrl}/assets/app.js?v=2&workspace=a%2Fb`);
  assert.match(String(response.headers['content-type']), /javascript/);
  assert.match(response.body, /知识工作台/);
});

test('remote relay forwards mutation bytes and conflict status with the remote Origin', async t => {
  const payload = '{"draft":"新的正文\\n第二行","baseVersion":7}';
  const failure = { error: { code: 'VERSION_CONFLICT', message: '版本已变化', details: { actual: 8 } } };
  const f = fixture(t, async (request, init) => {
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, `${remoteUrl}/api/v1/workspaces/w1/draft`);
    assert.equal(await request.text(), payload);
    assert.equal(request.headers.get('origin'), 'http://10.8.0.5:8888');
    assert.equal(request.headers.get('x-workbench-actor'), 'web');
    assert.match(request.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(init?.redirect, 'manual');
    return Response.json(failure, { status: 409 });
  });
  const response = await f.app.inject({
    method: 'PATCH', url: '/api/v1/workspaces/w1/draft', payload,
    headers: { ...localHeaders, 'x-workbench-actor': 'web', 'content-type': 'application/json' },
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), failure);
  assert.equal(f.calls.length, 1);
});

test('remote relay accepts CLI and MCP requests without a browser Origin', async t => {
  const f = fixture(t, request => Response.json({ actor: request.headers.get('x-workbench-actor') }));
  for (const actor of ['cli', 'mcp']) {
    const response = await f.app.inject({
      method: 'POST', url: '/api/v1/workspaces/w1/discover', payload: { terms: ['笔记'] },
      headers: { host: '127.0.0.1:3000', 'x-workbench-actor': actor },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().actor, actor);
  }
});

test('remote relay rejects foreign Host, Origin and undeclared writes before forwarding', async t => {
  const f = fixture(t, () => Response.json({ ok: true }));
  const requests = [
    { method: 'GET' as const, headers: { host: 'evil.example:3000' } },
    { method: 'GET' as const, headers: { ...localHeaders, origin: 'https://evil.example' } },
    { method: 'GET' as const, headers: { ...localHeaders, origin: 'null' } },
    { method: 'GET' as const, headers: { ...localHeaders, origin: 'http://10.8.0.5:8888' } },
    { method: 'GET' as const, headers: { ...localHeaders, origin: 'http://localhost:9999', 'x-forwarded-host': '127.0.0.1:3000' } },
    { method: 'PATCH' as const, headers: localHeaders },
    { method: 'PATCH' as const, headers: { ...localHeaders, 'x-workbench-actor': 'untrusted' } },
  ];
  for (const request of requests) {
    const response = await f.app.inject({ ...request, url: '/api/v1/workspaces/w1/draft' });
    assert.equal(response.statusCode, 403, JSON.stringify(request.headers));
  }
  assert.equal(f.calls.length, 0);
});

test('remote relay rejects a direct loop to its own listening port before fetching', async t => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const f = fixture(t, () => Response.json({ unexpected: true }), `http://localhost:${port}/flomo`);
  const local = await f.app.listen({ host: '127.0.0.1', port });
  // The loop check must use the socket port even when Host names a different port.
  const response = await fetch(`${local}/api/v1/health`, {
    headers: { host: 'localhost:65534' }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'REMOTE_LOOP');
  assert.equal(f.calls.length, 0);
});

test('remote relay rejects incoming paths that can escape the remote base before forwarding', async t => {
  const f = fixture(t, () => Response.json({ ok: true }));
  const local = new URL(await f.app.listen({ host: '127.0.0.1', port: 0 }));
  for (const url of [
    '//evil.example/knowledge/',
    '/../knowledge/',
    '/%2e%2e/knowledge/',
    '/one/../../knowledge/',
    '/one/%2e%2e/%2e%2e/knowledge/',
    '/%2f..%2fknowledge/',
    '/%5c..%5cknowledge/',
    '/bad%zz/',
  ]) {
    // inject/fetch normalize dot segments first; a raw HTTP path exercises the relay itself.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: local.hostname, port: local.port, method: 'GET', path: url, headers: localHeaders }, response => {
        response.resume();
        response.on('error', reject);
        response.on('end', () => resolve(response.statusCode!));
      });
      request.on('error', reject);
      request.end();
    });
    assert.ok(status >= 400 && status < 500, `${url}: ${status}`);
  }
  assert.equal(f.calls.length, 0);
});

test('remote relay preserves escaped slashes and query characters inside source identifiers', async t => {
  const articleId = 'id/with?query&fragment#中文';
  const path = `/api/v1/sources/${encodeURIComponent(articleId)}`;
  const f = fixture(t, request => {
    assert.equal(request.url, `${remoteUrl}${path}`);
    return Response.json({ id: articleId, content: '完整正文' });
  });
  const response = await f.app.inject({ method: 'GET', url: path, headers: localHeaders });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { id: articleId, content: '完整正文' });
});

test('remote relay translates redirects within its base to local paths without following them', async t => {
  for (const location of ['/flomo/?workspace=w1', `${remoteUrl}/?workspace=w1`]) {
    const f = fixture(t, (_request, init) => {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 307, headers: { location } });
    });
    const response = await f.app.inject({ method: 'GET', url: '/', headers: localHeaders });
    assert.equal(response.statusCode, 307);
    assert.equal(response.headers.location, '/?workspace=w1');
    assert.equal(f.calls.length, 1);
  }
});

test('remote relay rejects redirects outside the configured base without requesting their targets', async t => {
  for (const location of [
    'https://evil.example/leak?token=redirect-secret',
    '//evil.example/leak',
    '/knowledge/',
    '/flomo-other/',
    '../knowledge/',
    `${remoteUrl}/%2e%2e/knowledge/`,
  ]) {
    const f = fixture(t, () => new Response(null, { status: 302, headers: { location } }));
    const response = await f.app.inject({ method: 'GET', url: '/', headers: localHeaders });
    assert.equal(response.statusCode, 502, location);
    assert.equal(response.headers.location, undefined);
    assert.doesNotMatch(response.body, /redirect-secret|evil\.example/);
    assert.equal(f.calls.length, 1);
  }
});

test('remote relay rejects in-base redirects that would become a protocol-relative local Location', async t => {
  for (const location of ['/flomo//evil.example/leak', `${remoteUrl}//evil.example/leak`]) {
    const f = fixture(t, () => new Response(null, { status: 302, headers: { location } }));
    const response = await f.app.inject({ method: 'GET', url: '/', headers: localHeaders });
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers.location, undefined);
    assert.doesNotMatch(response.body, /evil\.example/);
    assert.equal(f.calls.length, 1);
  }
});

test('remote relay sanitizes transport failures', async t => {
  const f = fixture(t, () => { throw new Error('socks5://relay-user:transport-secret@127.0.0.1:1080 connection failed'); });
  const response = await f.app.inject({ method: 'GET', url: '/api/v1/health', headers: localHeaders });
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(response.body, /transport-secret|relay-user|socks5:/);
  assert.ok(response.json().error);
});

test('remote relay sanitizes upstream body failures before response streaming starts', async t => {
  const f = fixture(t, () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('body-stream-secret from upstream proxy')); },
  }), { headers: { 'content-type': 'application/json' } }));
  const response = await f.app.inject({ method: 'GET', url: '/api/v1/health', headers: localHeaders });
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(response.body, /body-stream-secret|upstream proxy/);
});

test('remote relay rejects invalid configuration without echoing credentials', () => {
  for (const url of [
    'ftp://example.com/flomo',
    'http://relay-user:configuration-secret@example.com/flomo',
    'http://example.com/flomo?token=configuration-secret',
    'http://example.com/flomo#configuration-secret',
    'configuration-secret',
  ]) {
    assert.throws(() => createRemoteWorkbenchApp({ remoteUrl: url }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /configuration-secret|relay-user/);
      return true;
    });
  }
  assert.throws(() => createRemoteWorkbenchApp({ remoteUrl, proxy: 'ftp://relay-user:configuration-secret@example.com' }), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /configuration-secret|relay-user/);
    return true;
  });
});

test('remote relay streams SSE promptly and releases the upstream connection on local disconnect', { timeout: 8000 }, async t => {
  let markDisconnected!: () => void;
  const disconnected = new Promise<void>(resolve => { markDisconnected = resolve; });
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/flomo/api/v1/events?after=41');
    assert.equal(request.headers['last-event-id'], '41');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('id: 42\nevent: change\ndata: {"id":42}\n\n');
    response.on('close', markDisconnected);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const app = createRemoteWorkbenchApp({ remoteUrl: `http://127.0.0.1:${address.port}/flomo` });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    upstream.closeAllConnections();
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  });
  const local = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${local}/api/v1/events?after=41`, {
    headers: { 'last-event-id': '41', accept: 'text/event-stream' }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /id: 42/);
  controller.abort();
  await reader.cancel().catch(() => {});
  reader.releaseLock();
  await disconnected;
});

test('remote relay streams decoded gzip responses without stale encoding or compressed content length', async t => {
  const page = '<!doctype html><title>远端工作台</title><main>' + '正文内容'.repeat(300) + '</main>';
  const compressed = gzipSync(page);
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/flomo/');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
    });
    response.end(compressed);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const app = createRemoteWorkbenchApp({ remoteUrl: `http://127.0.0.1:${address.port}/flomo` });
  t.after(async () => {
    upstream.closeAllConnections();
    await app.close();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  });
  const response = await app.inject({ method: 'GET', url: '/', headers: localHeaders });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, page);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['content-length'], undefined);
  assert.match(String(response.headers['content-type']), /text\/html/);
});
