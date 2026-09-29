import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireDatabaseLock } from '../server/lock.js';

async function directory() { return mkdtemp(join(tmpdir(), 'flomo-lock-test-')); }

test('concurrent acquirers have exactly one owner and release allows reuse', async () => {
  const dir = await directory();
  try {
    const path = join(dir, 'cache.db');
    const results = await Promise.allSettled([acquireDatabaseLock(path), acquireDatabaseLock(path)]);
    const winners = results.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const winner = winners[0]!;
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${path}.workbench.lock`)).mode & 0o777, 0o600);
    await winner.value.release();
    await winner.value.release();
    const next = await acquireDatabaseLock(path);
    await next.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('symlink aliases share the canonical database lock and existing bytes survive', async () => {
  const dir = await directory();
  try {
    const path = join(dir, 'cache.db');
    const alias = join(dir, 'alias.db');
    await writeFile(path, 'existing database content');
    await symlink(path, alias);
    const first = await acquireDatabaseLock(path);
    await assert.rejects(acquireDatabaseLock(alias), { code: 'DATABASE_LOCK_BUSY' });
    assert.equal(await readFile(path, 'utf8'), 'existing database content');
    await first.release();
    const second = await acquireDatabaseLock(alias);
    assert.equal(second.dbPath, first.dbPath);
    await second.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dead PID locks are reclaimed under the guard, including legacy PID files', async () => {
  const dir = await directory();
  try {
    const child = spawn(process.execPath, ['-e', '']);
    const exited = once(child, 'exit');
    const pid = child.pid!;
    await exited;
    const path = join(dir, 'cache.db');
    const lockPath = `${path}.workbench.lock`;
    for (const content of [String(pid), JSON.stringify({ pid, token: 'dead-owner' })]) {
      await writeFile(lockPath, content);
      const results = await Promise.allSettled([acquireDatabaseLock(path), acquireDatabaseLock(path)]);
      const winners = results.filter(result => result.status === 'fulfilled');
      assert.equal(winners.length, 1, 'stale recovery must preserve the first new owner');
      const acquired = winners[0]!.value;
      const current = JSON.parse(await readFile(lockPath, 'utf8'));
      assert.equal(current.pid, process.pid);
      assert.notEqual(current.token, 'dead-owner');
      await acquired.release();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release never removes a lock replaced by a newer owner', async () => {
  const dir = await directory();
  try {
    const acquired = await acquireDatabaseLock(join(dir, 'cache.db'));
    const lockPath = `${acquired.dbPath}.workbench.lock`;
    const replacement = JSON.stringify({ pid: process.pid, token: 'new-owner' });
    await writeFile(lockPath, replacement);
    await acquired.release();
    assert.equal(await readFile(lockPath, 'utf8'), replacement);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an abandoned guard is reported and never silently reclaimed', async () => {
  const dir = await directory();
  try {
    const path = join(dir, 'cache.db');
    const guardPath = `${path}.workbench.lock.guard`;
    const content = JSON.stringify({ pid: 2_147_483_647, token: 'abandoned-guard' });
    await writeFile(guardPath, content);
    await assert.rejects(acquireDatabaseLock(path), error => {
      assert.equal((error as Error & {code:string}).code, 'DATABASE_LOCK_GUARD');
      assert.match((error as Error).message, /手动移除/);
      return true;
    });
    assert.equal(await readFile(guardPath, 'utf8'), content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid ownership records are preserved for explicit recovery', async () => {
  const dir = await directory();
  try {
    const path = join(dir, 'cache.db');
    const lockPath = `${path}.workbench.lock`;
    await writeFile(lockPath, 'incomplete record');
    await assert.rejects(acquireDatabaseLock(path), { code: 'DATABASE_LOCK_INVALID' });
    assert.equal(await readFile(lockPath, 'utf8'), 'incomplete record');
    await assert.rejects(readFile(`${lockPath}.guard`), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
