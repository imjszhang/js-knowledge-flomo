import { z } from 'zod';
import type { CollectorArticle, CollectorArticleSummary } from '../shared/contracts.js';
import { ProviderError } from './provider-types.js';
import { createCollectorFetch } from './collector-fetch.js';

export interface CollectorProvider {
  findByUrl(url: string): Promise<CollectorArticleSummary[]>;
  get(id: string): Promise<CollectorArticle>;
}

export interface CollectorProviderOptions {
  baseUrl?: string;
  apiPrefix?: string;
  token?: string;
  proxy?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Tests can supply a transport without contacting a real collector. */
  fetch?: typeof fetch;
}

const optionalText = z.string().nullish().transform(value => value ?? '');
const articleSchema = z.object({
  id: z.string().min(1),
  title: optionalText,
  source_url: z.string().min(1),
  summary: optionalText,
  digest: optionalText,
  updated: optionalText,
});
const listSchema = z.object({
  status: z.literal('success'),
  data: z.array(articleSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
  truncated: z.boolean().optional(),
});
const detailSchema = z.object({
  status: z.literal('success'),
  data: articleSchema.extend({
    content: z.string().nullish(),
    content_truncated: z.boolean().optional(),
    contentTruncated: z.boolean().optional(),
    truncated: z.boolean().optional(),
  }),
  truncated: z.boolean().optional(),
});

function invalidResponse(): never {
  throw new ProviderError('收藏服务返回的数据格式不正确，请检查服务版本和接口配置。', 'INVALID_COLLECTOR_RESPONSE');
}

function validHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function summary(row: z.infer<typeof articleSchema>): CollectorArticleSummary {
  if (!validHttpUrl(row.source_url)) invalidResponse();
  return {
    id: row.id, title: row.title, sourceUrl: row.source_url,
    summary: row.summary, digest: row.digest, updatedAt: row.updated,
  };
}

/** Read-only access to the collector's existing article HTTP API. */
export function createCollectorProvider(options: CollectorProviderOptions = {}): CollectorProvider | undefined {
  const rawBase = (options.baseUrl ?? process.env.COLLECTOR_BASE_URL ?? '').trim();
  if (!rawBase) return undefined;
  const prefix = (options.apiPrefix ?? process.env.COLLECTOR_API_PREFIX ?? '/api/v1').trim().replace(/\/+$/, '');
  const token = options.token ?? process.env.COLLECTOR_TOKEN ?? '';
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const configError = () => new ProviderError('收藏服务配置无效，请检查 COLLECTOR_BASE_URL、COLLECTOR_API_PREFIX 和访问令牌。', 'COLLECTOR_CONFIG_INVALID', 503);
  if (!validHttpUrl(rawBase)) throw configError();
  const base = new URL(rawBase);
  if (base.search || base.hash || (prefix && (!prefix.startsWith('/') || /[?#\\\s]/.test(prefix))) ||
    prefix.split('/').some(segment => { try { return ['.', '..'].includes(decodeURIComponent(segment)); } catch { return true; } }) ||
    /[\r\n]/.test(token) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw configError();
  const apiBase = `${rawBase.replace(/\/+$/, '')}${prefix}`;
  const transport = options.fetch ?? createCollectorFetch(options.proxy ?? process.env.COLLECTOR_HTTP_PROXY) ?? fetch;

  const request = async (pathname: string, query?: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${apiBase}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await transport(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      // Never forward credentials to a redirect target, even on the same host.
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError('收藏服务返回了重定向，请将 COLLECTOR_BASE_URL 配置为接口的最终地址。', 'COLLECTOR_REDIRECT');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('收藏服务拒绝访问，请检查 COLLECTOR_TOKEN。', 'COLLECTOR_AUTH_REQUIRED', 503);
      }
      if (response.status === 404) throw new ProviderError('未找到收藏文章或接口，请检查文章是否存在及接口路径。', 'COLLECTOR_NOT_FOUND', 404);
      if (!response.ok) throw new ProviderError('收藏服务暂时无法完成请求，请稍后重试。', 'COLLECTOR_UNAVAILABLE');
      const declaredBytes = Number(response.headers.get('content-length'));
      if (declaredBytes > maxResponseBytes) {
        throw new ProviderError('收藏文章超过当前读取上限，未返回部分正文。', 'COLLECTOR_RESPONSE_TOO_LARGE', 422);
      }
      if (!response.body) invalidResponse();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) {
          throw new ProviderError('收藏文章超过当前读取上限，未返回部分正文。', 'COLLECTOR_RESPONSE_TOO_LARGE', 422);
        }
        chunks.push(chunk.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { return invalidResponse(); }
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError('读取收藏服务超时，请检查连接后重试。', 'COLLECTOR_TIMEOUT', 504);
      if (error instanceof ProviderError) throw error;
      // Upstream bodies, URLs and transport errors can contain credentials.
      throw new ProviderError('无法连接收藏服务，请检查服务地址及连接。', 'COLLECTOR_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      // Abort also closes an unread HTTP error/redirect body.
      controller.abort();
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
  };

  return {
    async findByUrl(url) {
      if (!validHttpUrl(url)) throw new ProviderError('只能按完整的 HTTP 或 HTTPS 链接查询收藏。', 'COLLECTOR_URL_INVALID', 400);
      const articles: CollectorArticleSummary[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      for (let page = 1; page <= 5; page++) {
        const parsed = listSchema.safeParse(await request('/articles.json', { sourceUrl: url, perPage: '100', page: String(page) }));
        if (!parsed.success) invalidResponse();
        const payload = parsed.data;
        if (payload.truncated || payload.totalItems > 100 || payload.totalPages > 5) {
          throw new ProviderError('该链接的收藏结果过多或不完整，请先在收藏库中核对。', 'COLLECTOR_RESULTS_LIMIT', 422);
        }
        if (payload.page !== page || payload.data.length > payload.perPage ||
          payload.totalPages !== Math.max(1, Math.ceil(payload.totalItems / payload.perPage)) ||
          (total !== undefined && payload.totalItems !== total)) invalidResponse();
        total = payload.totalItems;
        for (const row of payload.data) {
          if (row.source_url !== url || seen.has(row.id)) invalidResponse();
          seen.add(row.id);
          articles.push(summary(row));
        }
        if (page === payload.totalPages) {
          if (articles.length !== payload.totalItems) invalidResponse();
          return articles;
        }
        if (payload.data.length !== payload.perPage) invalidResponse();
      }
      return invalidResponse();
    },
    async get(id) {
      if (!id || id.length > 500) throw new ProviderError('收藏文章 ID 无效。', 'COLLECTOR_ID_INVALID', 400);
      const parsed = detailSchema.safeParse(await request(`/articles/${encodeURIComponent(id)}.json`));
      if (!parsed.success) invalidResponse();
      const { data } = parsed.data;
      if (data.id !== id) invalidResponse();
      if (!data.content?.trim() || data.content_truncated || data.contentTruncated || data.truncated || parsed.data.truncated) {
        throw new ProviderError('这篇收藏暂无完整正文，无法作为全文材料使用。', 'COLLECTOR_CONTENT_UNAVAILABLE', 422);
      }
      return { ...summary(data), content: data.content, contentTruncated: false };
    },
  };
}

const htmlEntities: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', sol: '/',
  equals: '=', num: '#', percnt: '%', quest: '?', lpar: '(', rpar: ')',
  nbsp: '\u00a0', Tab: '\t', NewLine: '\n',
};
function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-zA-Z]+);/gi, (original, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
    }
    return htmlEntities[entity] ?? original;
  });
}

/** Extract URLs without canonicalizing, resolving redirects or deleting query fields. */
export function extractSourceUrls(content: string): string[] {
  const found: { offset: number; url: string }[] = [];
  const masked = content.split('');
  const mask = (start: number, end: number) => { for (let i = start; i < end; i++) masked[i] = ' '; };
  const add = (url: string, offset: number, markdown = false, plain = false) => {
    let decoded = decodeEntities(markdown ? url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1') : url);
    if (plain) {
      decoded = decoded.replace(/[。，、；：！？）》】」』]+$/, '');
      // Punctuation inside a query or fragment may be meaningful article identity.
      if (!/[?#]/.test(decoded)) decoded = decoded.replace(/[.,;!]+$/, '');
      // Sentence or Markdown delimiters are removed only when unbalanced.
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (decoded.endsWith(close) && decoded.split(close).length > decoded.split(open).length) decoded = decoded.slice(0, -1);
      }
    }
    if (!validHttpUrl(decoded)) return;
    const host = new URL(decoded).hostname.toLowerCase();
    if (host === 'flomoapp.com' || host.endsWith('.flomoapp.com')) return;
    found.push({ offset, url: decoded });
  };
  // Read link destinations from HTML, then hide tags so href text isn't read twice.
  for (const tag of content.matchAll(/<\/?[a-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/gi)) {
    for (const href of tag[0].matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      add(href[1] ?? href[2] ?? href[3], tag.index + href.index);
    }
    mask(tag.index, tag.index + tag[0].length);
  }
  const visible = masked.join('');
  // A small destination scanner handles nested and escaped URL parentheses.
  for (const match of visible.matchAll(/\]\(\s*/g)) {
    const start = match.index + match[0].length;
    let end = start;
    let url = '';
    if (visible[start] === '<') {
      end = visible.indexOf('>', start + 1);
      if (end < 0) continue;
      url = visible.slice(start + 1, end);
      end++;
    } else {
      let depth = 0;
      while (end < visible.length) {
        const char = visible[end];
        if (char === '\\' && end + 1 < visible.length) { end += 2; continue; }
        if (/\s/.test(char)) break;
        if (char === '(') depth++;
        if (char === ')') { if (depth === 0) break; depth--; }
        end++;
      }
      if (depth) continue;
      url = visible.slice(start, end);
    }
    const suffix = visible.slice(end).match(/^\s*(?:(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\))\s*)?\)/);
    if (!suffix) continue;
    add(url, start, true);
    mask(start, end + suffix[0].length);
  }
  for (const match of masked.join('').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    add(match[0], match.index, false, true);
  }
  return [...new Set(found.sort((a, b) => a.offset - b.offset).map(item => item.url))];
}
