import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { WorkbenchService } from './service.js';
import { createFlomoProvider, createAIProvider, isAIConfigured, isFlomoConfigured } from './providers.js';
import { createApp } from './app.js';
import { acquireDatabaseLock } from './lock.js';
import { createCollectorProvider } from './collector.js';
import { createRemoteWorkbenchApp } from './remote-workbench.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');

async function startLocalWorkbench() {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = existsSync(resolve(here,'../package.json')) ? resolve(here,'..') : resolve(here,'../..');
  const requestedDbPath = resolve(process.env.WORKBENCH_DB_PATH || process.env.DB_PATH || resolve(projectRoot, 'data/cache.db'));
  const databaseLock = await acquireDatabaseLock(requestedDbPath);
  let store: Store;
  try { store = await Store.open(databaseLock.dbPath); }
  catch (error) { await databaseLock.release(); throw error; }
  const service = new WorkbenchService(store, createFlomoProvider(), isAIConfigured() ? createAIProvider() : undefined, createCollectorProvider());
  await service.recover();
  const allowedOrigins = (process.env.WORKBENCH_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const gatewayPorts = (process.env.WORKBENCH_GATEWAY_PORTS || '').split(',').map(value => value.trim()).filter(Boolean).map(Number);
  const gatewaySubnets = (process.env.WORKBENCH_GATEWAY_SUBNETS || '').split(',').map(value => value.trim()).filter(Boolean);
  const app = await createApp({service, webRoot:resolve(projectRoot,'dist/web'),flomoConfigured:isFlomoConfigured,periodicRefresh:true,
    allowedOrigins,gatewayOrigins:{ports:gatewayPorts,subnets:gatewaySubnets}});
  let closing = false;
  async function close() {
    if (closing) return; closing = true;
    try { await app.close(); }
    finally { try { await store.close(); } finally { await databaseLock.release(); } }
  }
  process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
  try {
    await app.listen({port,host:'127.0.0.1'});
    process.stderr.write(`flomo 工作台：http://127.0.0.1:${port}\n`);
  } catch (error) { await close(); throw error; }
}

if (process.env.WORKBENCH_REMOTE_URL?.trim()) {
  const app = createRemoteWorkbenchApp({ remoteUrl: process.env.WORKBENCH_REMOTE_URL, proxy: process.env.WORKBENCH_REMOTE_PROXY });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  try {
    await app.listen({ port, host: '127.0.0.1' });
    process.stderr.write(`远端工作台入口：http://127.0.0.1:${port}（共用远端数据）\n`);
  } catch (error) { await app.close(); throw error; }
} else {
  await startLocalWorkbench();
}
