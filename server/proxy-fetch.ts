import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';

/** Per-connection transport: never changes the process or browser proxy. */
export function createProxyTransport(proxyUrl?: string): { fetch: typeof fetch; close: () => Promise<void> } {
  if (!proxyUrl?.trim()) return { fetch: globalThis.fetch, close: async () => {} };
  try {
    const url = new URL(proxyUrl);
    if (url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error();
    const dispatcher = url.protocol === 'socks5:' || url.protocol === 'socks5h:'
      ? socksDispatcher({ type: 5, host: url.hostname, port: Number(url.port) || 1080,
        ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      })
      : url.protocol === 'http:' || url.protocol === 'https:' ? new ProxyAgent(proxyUrl) : undefined;
    if (!dispatcher) throw new Error();
    return {
      fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...init, dispatcher,
      } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch,
      close: () => dispatcher.close(),
    };
  } catch {
    throw new Error('代理配置无效，请使用 HTTP 或 SOCKS5 代理地址');
  }
}
