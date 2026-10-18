import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface GatewayOrigins {
  ports: number[];
  subnets?: string[];
  /** Read at request time so DHCP changes do not require a restart. */
  localAddresses?: () => readonly string[];
}

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function subnetMatcher(cidr: string): (address: number) => boolean {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(cidr);
  const address = match ? ipv4Number(match[1]) : undefined;
  const bits = match ? Number(match[2]) : -1;
  if (address === undefined || bits < 0 || bits > 32)
    throw new Error(`无效的工作台网关 IPv4 网段：${cidr}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (address & mask) >>> 0;
  if (network !== address) throw new Error(`工作台网关网段必须使用网络地址：${cidr}`);
  return value => ((value & mask) >>> 0) === network;
}

function currentLocalAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === 'IPv4').map(entry => entry.address));
}

export function createOriginPolicy(allowedOrigins: string[] = [], gateway?: GatewayOrigins) {
  const trustedOrigins = new Set(allowedOrigins);
  const ports = new Set(gateway?.ports ?? []);
  if ([...ports].some(port => !Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error('工作台网关端口必须在 1–65535 之间');
  const subnets = (gateway?.subnets ?? []).map(subnetMatcher);
  if (subnets.length && !ports.size) throw new Error('配置工作台网关网段时必须指定网关端口');
  const localAddresses = gateway?.localAddresses ?? currentLocalAddresses;

  return (origin: string, backendHost: string): boolean => {
    let url: URL;
    try { url = new URL(origin); } catch { return false; }
    // Comparing the serialized origin also rejects credentials, paths, multiple
    // values and noncanonical IP spellings before any subnet/local-IP matching.
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return false;
    if (trustedOrigins.has(origin)) return true;
    if (url.protocol !== 'http:') return false;
    if (loopbackHosts.has(url.hostname) &&
        (url.host === backendHost || ['5173', '5174'].includes(url.port))) return true;
    if (!ports.has(Number(url.port || 80))) return false;
    if (loopbackHosts.has(url.hostname)) return true;
    const address = ipv4Number(url.hostname);
    if (address === undefined) return false;
    return subnets.some(matches => matches(address)) || localAddresses().includes(url.hostname);
  };
}
