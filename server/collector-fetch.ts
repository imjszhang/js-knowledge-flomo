import { ProviderError } from './provider-types.js';
import { createProxyTransport } from './proxy-fetch.js';

/** Only collector requests use this proxy; flomo and model requests stay unchanged. */
export function createCollectorFetch(proxyUrl?: string): typeof fetch | undefined {
  if (!proxyUrl?.trim()) return undefined;
  try {
    return createProxyTransport(proxyUrl).fetch;
  } catch {
    throw new ProviderError('收藏库代理配置无效，请使用 HTTP 或 SOCKS5 代理地址', 'INVALID_COLLECTOR_PROXY', 503);
  }
}
