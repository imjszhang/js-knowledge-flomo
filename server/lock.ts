import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface Owner { pid: number; token?: string }

export class DatabaseLockError extends Error {
  constructor(message: string, readonly code: 'DATABASE_LOCK_BUSY' | 'DATABASE_LOCK_GUARD' | 'DATABASE_LOCK_INVALID') {
    super(message);
    this.name = 'DatabaseLockError';
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function parseOwner(content: string): Owner | undefined {
  try {
    const data: unknown = JSON.parse(content);
    // Earlier versions used a plain PID; preserve safe stale-lock recovery.
    const pid = typeof data === 'number' ? data : typeof data === 'object' && data !== null && 'pid' in data ? data.pid : undefined;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return undefined;
    const token = typeof data === 'object' && data !== null && 'token' in data && typeof data.token === 'string' ? data.token : undefined;
    return { pid, token };
  } catch { return undefined; }
}

async function readOwner(path: string): Promise<Owner | 'invalid' | null> {
  try { return parseOwner(await readFile(path, 'utf8')) ?? 'invalid'; }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

function ownerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    // An inaccessible process may still own the database. Never reclaim it.
    if (errorCode(error) === 'EPERM') return true;
    throw error;
  }
}

async function removeOwned(path: string, owner: Owner): Promise<void> {
  const current = await readOwner(path);
  if (current && current !== 'invalid' && current.pid === owner.pid && current.token === owner.token) {
    await unlink(path);
  }
}

async function withGuard<T>(path: string, operation: () => Promise<T>, retry = false): Promise<T> {
  let handle;
  const deadline = Date.now() + (retry ? 1_000 : 0);
  for (;;) {
    try { handle = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (Date.now() < deadline) { await new Promise(resolveWait => setTimeout(resolveWait, 20)); continue; }
      throw new DatabaseLockError(`另一个服务正在检查数据库锁，或上次检查曾中断。请稍后重试；若此文件持续存在，请确认没有服务在启动或退出后，再手动移除：${path}`, 'DATABASE_LOCK_GUARD');
    }
  }
  const guardOwner = { pid: process.pid, token: randomUUID() };
  try {
    await handle.writeFile(JSON.stringify(guardOwner));
    await handle.close();
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    // An incomplete guard is deliberately retained after a failed write. A later
    // process must not guess whether an interrupted critical section is safe.
    await removeOwned(path, guardOwner);
  }
}

/**
 * Own the database across processes. All acquisitions and releases hold the
 * same guard, so stale PID recovery cannot unlink a newly acquired owner.
 */
export async function acquireDatabaseLock(requestedPath: string): Promise<{ dbPath: string; release: () => Promise<void> }> {
  const absolutePath = resolve(requestedPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const file = await open(absolutePath, 'a', 0o600);
  await file.close();
  const dbPath = await realpath(absolutePath);
  const lockPath = `${dbPath}.workbench.lock`;
  const guardPath = `${lockPath}.guard`;
  const owner = { pid: process.pid, token: randomUUID() };

  await withGuard(guardPath, async () => {
    const previous = await readOwner(lockPath);
    if (previous === 'invalid') {
      throw new DatabaseLockError(`数据库锁文件格式无效，请确认没有服务正在运行后检查：${lockPath}`, 'DATABASE_LOCK_INVALID');
    }
    if (previous) {
      if (ownerIsAlive(previous.pid)) {
        throw new DatabaseLockError('该数据库已有工作台服务运行，请连接现有服务。', 'DATABASE_LOCK_BUSY');
      }
      await unlink(lockPath);
    }
    const lock = await open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(JSON.stringify(owner)); }
    finally { await lock.close(); }
  });

  let released = false;
  return {
    dbPath,
    async release() {
      if (released) return;
      await withGuard(guardPath, () => removeOwned(lockPath, owner), true);
      released = true;
    },
  };
}
