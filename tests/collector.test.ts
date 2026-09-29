import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createCollectorProvider, extractSourceUrls, type CollectorProviderOptions } from '../server/collector.js';

const sourceUrl = 'https://mp.weixin.qq.com/s?__biz=Mz%2B123&mid=42&idx=1&sn=A%2fb#wechat_redirect';
const row = (id = 'article-1', overrides: Record<string, unknown> = {}) => ({
  id, title: '原文标题', source_url: sourceUrl, summary: '摘要', digest: '概要', ...overrides,
});
const list = (rows = [row()], overrides: Record<string, unknown> = {}) => ({
  status: 'success', data: rows, page: 1, perPage: 100, totalItems: rows.length, totalPages: 1, ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}) => ({
  status: 'success', data: row('article-1', { content: '完整原文', updated: '2026-09-29T10:00:00Z', ...overrides }),
});

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    provider: (options: CollectorProviderOptions = {}) => createCollectorProvider({
      baseUrl, apiPrefix: '/api/v1', token: '', proxy: '', ...options,
    })!,
  };
}
function json(res: ServerResponse, data: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}

test('collector is optional, validates configuration and never echoes embedded credentials', () => {
  assert.equal(createCollectorProvider({ baseUrl: '' }), undefined);
  for (const baseUrl of ['ftp://example.com', 'http://secret:password@example.com', 'https://example.com?token=secret', 'not-a-url']) {
    assert.throws(() => createCollectorProvider({ baseUrl }), error => {
      assert.equal((error as { code: string }).code, 'COLLECTOR_CONFIG_INVALID');
      assert.doesNotMatch((error as Error).message, /secret|password/);
      return true;
    });
  }
  for (const apiPrefix of ['https://example.org', '/../elsewhere', '/api?token=secret', '/%2e%2e']) {
    assert.throws(() => createCollectorProvider({ baseUrl: 'http://localhost', apiPrefix }), { code: 'COLLECTOR_CONFIG_INVALID' });
  }
});

test('URL lookup sends exact parameters and optional bearer token, maps summaries and multiple matches', async t => {
  const server = await fixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    assert.equal(req.method, 'GET');
    assert.equal(url.pathname, '/knowledge/api/v1/articles.json');
    assert.equal(url.searchParams.get('sourceUrl'), sourceUrl);
    assert.equal(url.searchParams.get('perPage'), '100');
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    json(res, list([row('one'), row('two', { summary: null, digest: null })]));
  });
  assert.deepEqual(await server.provider({ baseUrl: `${server.baseUrl}/knowledge/`, token: 'test-secret' }).findByUrl(sourceUrl), [
    { id: 'one', title: '原文标题', sourceUrl, summary: '摘要', digest: '概要', updatedAt: '' },
    { id: 'two', title: '原文标题', sourceUrl, summary: '', digest: '', updatedAt: '' },
  ]);
});

test('URL lookup follows bounded pagination and preserves missing results', async t => {
  const server = await fixture(t, (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.searchParams.get('sourceUrl') === 'https://example.com/missing') return json(res, list([]));
    const page = Number(url.searchParams.get('page'));
    json(res, list([row(String(page))], { page, perPage: 1, totalItems: 2, totalPages: 2 }));
  });
  const provider = server.provider();
  assert.deepEqual((await provider.findByUrl(sourceUrl)).map(article => article.id), ['1', '2']);
  assert.deepEqual(await provider.findByUrl('https://example.com/missing'), []);
});

test('detail reads retain complete large content and safely encode the article ID in the path', async t => {
  const id = 'id/with?query&fragment#中文';
  const content = '全文中的每一个字都应该保留。\n'.repeat(10_000);
  const server = await fixture(t, (req, res) => {
    assert.equal(req.url, `/api/v1/articles/${encodeURIComponent(id)}.json`);
    json(res, detail({ id, content }));
  });
  const article = await server.provider().get(id);
  assert.equal(article.content, content);
  assert.equal(article.contentTruncated, false);
  assert.equal(article.updatedAt, '2026-09-29T10:00:00Z');
});

test('HTTP failures remain distinguishable and never disclose upstream response bodies', async t => {
  for (const [status, code] of [[401, 'COLLECTOR_AUTH_REQUIRED'], [403, 'COLLECTOR_AUTH_REQUIRED'], [404, 'COLLECTOR_NOT_FOUND'], [500, 'COLLECTOR_UNAVAILABLE']] as const) {
    await t.test(String(status), async t => {
      const server = await fixture(t, (_req, res) => {
        res.writeHead(status);
        res.end('upstream-secret-token');
      });
      await assert.rejects(server.provider().get('article-1'), error => {
        assert.equal((error as { code: string }).code, code);
        assert.doesNotMatch((error as Error).message, /upstream-secret-token/);
        return true;
      });
    });
  }
});

test('redirects are rejected before any request or credential reaches the target', async t => {
  let redirectedCalls = 0;
  const target = await fixture(t, (_req, res) => { redirectedCalls++; json(res, detail()); });
  const origin = await fixture(t, (_req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}/api/v1/articles/article-1.json` });
    res.end();
  });
  await assert.rejects(origin.provider({ token: 'test-secret' }).get('article-1'), { code: 'COLLECTOR_REDIRECT' });
  assert.equal(redirectedCalls, 0);
});

test('collector validates JSON, schemas, exact matches, IDs and pagination rather than accepting partial results', async t => {
  const cases: { name: string; body: unknown; read: 'list' | 'get'; code?: string }[] = [
    { name: 'non-JSON', body: '<html>login-secret</html>', read: 'get' },
    { name: 'failed envelope', body: { status: 'error', data: row() }, read: 'get' },
    { name: 'missing identity', body: { status: 'success', data: { content: 'body' } }, read: 'get' },
    { name: 'wrong identity', body: detail({ id: 'someone-else' }), read: 'get' },
    { name: 'malformed source', body: detail({ source_url: 'javascript:alert(1)' }), read: 'get' },
    { name: 'malformed title', body: detail({ title: { unexpected: true } }), read: 'get' },
    { name: 'unfiltered result', body: list([row('1', { source_url: 'https://example.com/other' })]), read: 'list' },
    { name: 'missing list', body: { status: 'success' }, read: 'list' },
    { name: 'wrong total', body: list([], { totalItems: 1 }), read: 'list' },
    { name: 'wrong page', body: list([row()], { page: 2 }), read: 'list' },
    { name: 'duplicate matches', body: list([row(), row()]), read: 'list' },
    { name: 'too many matches', body: list([], { totalItems: 101, totalPages: 2 }), read: 'list', code: 'COLLECTOR_RESULTS_LIMIT' },
    { name: 'truncated matches', body: list([], { truncated: true }), read: 'list', code: 'COLLECTOR_RESULTS_LIMIT' },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const server = await fixture(t, (_req, res) => typeof item.body === 'string' ? res.end(item.body) : json(res, item.body));
    const provider = server.provider();
    await assert.rejects(item.read === 'get' ? provider.get('article-1') : provider.findByUrl(sourceUrl), { code: item.code ?? 'INVALID_COLLECTOR_RESPONSE' });
  });
});

test('detail cannot silently substitute summaries, omitted or truncated text for full content', async t => {
  for (const overrides of [{ content: undefined }, { content: null }, { content: '' }, { content_truncated: true }, { contentTruncated: true }, { truncated: true }]) {
    const server = await fixture(t, (_req, res) => json(res, detail(overrides)));
    await assert.rejects(server.provider().get('article-1'), { code: 'COLLECTOR_CONTENT_UNAVAILABLE' });
  }
});

test('response byte limits cover declared size and chunked bodies without returning shortened text', async t => {
  for (const withLength of [false, true]) await t.test(withLength ? 'content-length' : 'chunked', async t => {
    const server = await fixture(t, (_req, res) => {
      const body = JSON.stringify(detail({ content: '大'.repeat(500) }));
      if (withLength) res.setHeader('content-length', Buffer.byteLength(body));
      else res.write(body.slice(0, 50));
      res.end(withLength ? body : body.slice(50));
    });
    await assert.rejects(server.provider({ maxResponseBytes: 600 }).get('article-1'), { code: 'COLLECTOR_RESPONSE_TOO_LARGE' });
  });
});

test('timeouts cover both connection response and a stalled body', async t => {
  for (const bodyStarted of [false, true]) await t.test(bodyStarted ? 'body' : 'headers', async t => {
    const server = await fixture(t, (_req, res) => {
      if (bodyStarted) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"status":"success","data":');
      }
    });
    await assert.rejects(server.provider({ timeoutMs: 80 }).get('article-1'), { code: 'COLLECTOR_TIMEOUT' });
  });
});

test('transport errors do not expose credentials or URLs from an exception', async () => {
  const provider = createCollectorProvider({
    baseUrl: 'http://localhost', token: 'secret',
    fetch: async () => { throw new Error('http://secret:password@host'); },
  })!;
  await assert.rejects(provider.get('1'), error => {
    assert.equal((error as { code: string }).code, 'COLLECTOR_UNAVAILABLE');
    assert.doesNotMatch((error as Error).message, /secret|password|host/);
    return true;
  });
});

test('extracts Markdown destinations with balanced and escaped parentheses and excludes their titles', () => {
  assert.deepEqual(extractSourceUrls([
    '[原文](https://en.wikipedia.org/wiki/Function_(mathematics))',
    '[转义](https://example.com/a\\(b\\)?x=1&y=2 "https://title.example/ignore")',
    '[尖括号](<https://example.com/end.> "标题")',
    '<https://example.com/autolink>',
  ].join('\n')), [
    'https://en.wikipedia.org/wiki/Function_(mathematics)',
    'https://example.com/a(b)?x=1&y=2',
    'https://example.com/end.',
    'https://example.com/autolink',
  ]);
});

test('HTML hrefs and visible body URLs decode entities, retain query spelling and deduplicate exact URLs', () => {
  assert.deepEqual(extractSourceUrls([
    '<p><a href="https://example.com/a(b)?x=1&amp;y=%2b">https://example.com/a(b)?x=1&amp;y=%2b</a></p>',
    "<a href='https://example.com/b?x=&#49;&amp;y=&#x32;'>原文</a>",
    '<a href=https://example.com/c?x=1&amp;y=2>原文</a>',
    'https://example.com/a(b)?x=1&y=%2b',
    'https://example.com/a(b)?x=1&y=%2B',
    'https://example.com/ending?x=&amp;',
    'https://example.com/punctuation?x=ends!',
    '<span data-href="https://not-a-link.example/">text</span>',
  ].join('\n')), [
    'https://example.com/a(b)?x=1&y=%2b',
    'https://example.com/b?x=1&y=2',
    'https://example.com/c?x=1&y=2',
    'https://example.com/a(b)?x=1&y=%2B',
    'https://example.com/ending?x=&',
    'https://example.com/punctuation?x=ends!',
  ]);
});

test('plain extraction handles surrounding punctuation and excludes flomo and non-HTTP destinations', () => {
  assert.deepEqual(extractSourceUrls([
    '(https://example.com/one_(two)).',
    '原文：https://example.com/two。',
    'https://flomoapp.com/memo/1 https://v.flomoapp.com/mine/?memo_id=2',
    '[无效](javascript:alert(1)) [文件](file:///etc/passwd)',
    'https://notflomoapp.com/valid https://flomoapp.com.example.org/valid',
    'https://user:secret@example.com/private',
  ].join('\n')), [
    'https://example.com/one_(two)',
    'https://example.com/two',
    'https://notflomoapp.com/valid',
    'https://flomoapp.com.example.org/valid',
  ]);
});

test('flomo Markdown exports restore escaped punctuation in bare source URLs without changing their query identity', () => {
  assert.deepEqual(extractSourceUrls([
    String.raw`\- 原文链接：https://www.zhihu.com/question/2078550836104394358/answer/2087601635543495695?share\_code=p9oOzR7JMXOw&utm\_psn=2088411714484290935`,
    String.raw`https://example.com/a\(b\)?under\_score=1\&encoded=%5C%5f%2b\#part\_one`,
    String.raw`https://example.com/quotes?x=\'quoted\'\&y=\"double\"\&z=\!`,
  ].join('\n')), [
    'https://www.zhihu.com/question/2078550836104394358/answer/2087601635543495695?share_code=p9oOzR7JMXOw&utm_psn=2088411714484290935',
    'https://example.com/a(b)?under_score=1&encoded=%5C%5f%2b#part_one',
    'https://example.com/quotes?x=\'quoted\'&y="double"&z=!',
  ]);
});

test('URL-shaped Markdown labels are not extracted as extra sources beside their destinations', () => {
  const url = 'https://www.zhihu.com/question/2078550836104394358/answer/2087601635543495695?share_code=p9oOzR7JMXOw&utm_psn=2088411714484290935';
  const label = url.replace(/_/g, '\\_');
  const destination = url.replace(/&/g, '\\&');
  assert.deepEqual(extractSourceUrls(`[${label}](${destination})\n${url}`), [url]);
  assert.deepEqual(extractSourceUrls([
    '[https://display.example/wrong](https://target.example/right "https://title.example/wrong")',
    String.raw`[说明 [https://nested.example/wrong] 与 \[转义\]](https://target.example/nested)`,
    '[https://display.example/not-a-source](javascript:alert(1))',
    '正文 https://plain.example/after',
  ].join('\n')), ['https://target.example/right','https://target.example/nested','https://plain.example/after']);
});

test('HTML hrefs keep literal and percent-encoded query values rather than applying Markdown unescaping', () => {
  assert.deepEqual(extractSourceUrls(String.raw`<a href="https://example.com/?key\_one=%5C%5F&amp;key_two=%2b">https://example.com/?key\_one=%5C%5F&amp;key_two=%2b</a>`), [
    String.raw`https://example.com/?key\_one=%5C%5F&key_two=%2b`,
  ]);
  assert.deepEqual(extractSourceUrls('<p><a href="https://target.example/right"><strong>https://display.example/wrong</strong></a> https://plain.example/after</p>'), [
    'https://target.example/right','https://plain.example/after',
  ]);
});
