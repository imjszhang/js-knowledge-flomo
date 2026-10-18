import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { createOriginPolicy, loopbackHosts } from './origin-policy.js';
import { createProxyTransport } from './proxy-fetch.js';

interface RemoteOptions {
  remoteUrl: string;
  proxy?: string;
  fetch?: typeof globalThis.fetch;
}

function remoteBase(value: string): URL {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url;
  } catch {
    throw new Error('WORKBENCH_REMOTE_URL 必须是 HTTP(S) 工作台地址，不能包含账号、密码、查询参数或片段');
  }
}

/** Serve the remote UI and its API together; no local database is opened. */
export function createRemoteWorkbenchApp(options: RemoteOptions) {
  const base = remoteBase(options.remoteUrl);
  const transport = createProxyTransport(options.proxy);
  const fetchRemote = options.fetch ?? transport.fetch;
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const allowsOrigin = createOriginPolicy();
  const pending = new Set<AbortController>();
  const failure = (code: string, message: string) => ({ error: { code, message } });
  const inBase = (url: URL) => url.origin === base.origin && url.pathname.startsWith(base.pathname);

  // Streaming errors before the first byte also pass through this handler.
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 502;
    return reply.code(status >= 400 && status < 500 ? status : 502)
      .send(failure('REMOTE_REQUEST_FAILED', '工作台请求未完成，请检查连接后刷新确认'));
  });

  app.addHook('onRequest', async (request, reply) => {
    let hostname = '';
    try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch {}
    if (!loopbackHosts.has(hostname)) return reply.code(403).send(failure('INVALID_HOST', '工作台仅允许本机访问'));
    if (!options.proxy?.trim() && base.protocol === 'http:' && loopbackHosts.has(base.hostname) &&
        Number(base.port || 80) === request.raw.socket.localPort)
      return reply.code(502).send(failure('REMOTE_LOOP', '远端地址指向了当前本地入口，请填写另一台设备上的工作台地址'));
    if (request.headers.origin && !allowsOrigin(request.headers.origin, request.headers.host!))
      return reply.code(403).send(failure('INVALID_ORIGIN', '不允许此来源访问本地工作台'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !['web', 'cli', 'mcp'].includes(String(request.headers['x-workbench-actor'] ?? '')))
      return reply.code(403).send(failure('ACTOR_REQUIRED', '写入请求必须声明工作台入口'));
    reply.headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
  });
  // Keep JSON bytes unchanged, including idempotency keys and version checks.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/*', handler: async (request, reply) => {
    let target: URL;
    try {
      const path = request.url.split('?')[0];
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error();
      if (decodeURIComponent(path).split(/[/\\]/).some(part => ['.', '..'].includes(part))) throw new Error();
      target = new URL(`${base.href}${request.url.slice(1)}`);
      if (!inBase(target)) throw new Error();
    } catch {
      return reply.code(400).send(failure('INVALID_PATH', '工作台请求路径无效'));
    }
    const controller = new AbortController();
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const cleanup = () => { clearTimeout(timeout); controller.abort(); pending.delete(controller); };
    reply.raw.once('close', cleanup);
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'x-workbench-actor', 'last-event-id', 'if-none-match', 'if-modified-since']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    if (request.headers.origin) headers.set('origin', base.origin);
    try {
      const response = await fetchRemote(target, {
        method: request.method, headers, redirect: 'manual', signal: controller.signal,
        ...(['GET', 'HEAD'].includes(request.method) || request.body === undefined ? {} : { body: request.body as BodyInit }),
      });
      clearTimeout(timeout);
      const location = response.headers.get('location');
      if (location) {
        const redirected = new URL(location, target);
        const localPath = `/${redirected.pathname.slice(base.pathname.length)}`;
        if (!inBase(redirected) || localPath.startsWith('//')) {
          await response.body?.cancel();
          return reply.code(502).send(failure('REMOTE_REDIRECT_BLOCKED', '远端工作台跳转到了配置范围之外，请检查远端地址'));
        }
        reply.header('location', `${localPath}${redirected.search}${redirected.hash}`);
      }
      // fetch decodes compressed bodies: do not forward encoding or length.
      for (const name of ['content-type', 'content-disposition', 'etag', 'last-modified', 'retry-after', 'x-accel-buffering']) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.code(response.status);
      if (!response.body || request.method === 'HEAD') {
        await response.body?.cancel();
        return reply.send();
      }
      return reply.send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
    } catch {
      return reply.code(502).send(failure('REMOTE_UNAVAILABLE', '暂时无法连接远端工作台，请检查远端服务和代理。写入结果不确定时，请先刷新确认再重试。'));
    }
  } });
  app.addHook('preClose', async () => { for (const controller of pending) controller.abort(); });
  app.addHook('onClose', async () => { await transport.close(); });
  return app;
}
