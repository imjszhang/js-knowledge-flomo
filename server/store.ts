import sqlite3 from 'sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Actor, Change, Job, Settings, Workspace } from '../shared/contracts.js';
import { pinnedTags } from '../shared/contracts.js';
import { AppError } from './errors.js';

/** One writer owns both state and the durable change cursor. Legacy tables stay intact. */
export class Store {
  readonly events = new EventEmitter();
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private db: sqlite3.Database) { this.events.setMaxListeners(100); }

  static async open(filename: string): Promise<Store> {
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const handle = new sqlite3.Database(filename, err => err ? reject(err) : resolve(handle));
    });
    const store = new Store(db);
    await store.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workbench_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_workspaces(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_jobs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(workspace_id, kind, request_key));
      CREATE TABLE IF NOT EXISTS workbench_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      INSERT OR IGNORE INTO workbench_migrations VALUES(1, datetime('now'));
    `);
    await store.run('INSERT OR IGNORE INTO workbench_settings VALUES(1, ?)', [JSON.stringify({ pinnedTags: [...pinnedTags], refreshSeconds: 0 })]);
    return store;
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.db.exec(sql, err => err ? reject(err) : resolve()));
  }
  private run(sql: string, params: unknown[] = []): Promise<{lastID: number; changes: number}> {
    return new Promise((resolve, reject) => this.db.run(sql, params, function(err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    }));
  }
  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows as T[])));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async record(change: Omit<Change, 'id' | 'createdAt'>): Promise<Change> {
    const entry = { ...change, createdAt: new Date().toISOString() };
    const { lastID } = await this.run('INSERT INTO workbench_changes(data) VALUES(?)', [JSON.stringify(entry)]);
    return { ...entry, id: lastID };
  }
  private async transaction<T>(work: () => Promise<{ value: T; change: Change }>): Promise<T> {
    await this.exec('BEGIN IMMEDIATE');
    let committed: {value:T;change:Change};
    try {
      committed = await work();
      await this.exec('COMMIT');
    } catch (error) { await this.exec('ROLLBACK'); throw error; }
    // Observers are advisory: a failed socket cannot turn a committed save into an error.
    for (const listener of this.events.rawListeners('change')) {
      try { listener.call(this.events, committed.change); } catch { /* durable cursor allows the client to replay */ }
    }
    return committed.value;
  }
  private async readWorkspace(id: string): Promise<Workspace> {
    const [row] = await this.all<{data: string}>('SELECT data FROM workbench_workspaces WHERE id=?', [id]);
    if (!row) throw new AppError('NOT_FOUND', '加工会话不存在', 404);
    return JSON.parse(row.data) as Workspace;
  }
  getWorkspace(id: string): Promise<Workspace> { return this.serial(() => this.readWorkspace(id)); }
  listWorkspaces(): Promise<Workspace[]> {
    return this.serial(async () => (await this.all<{data: string}>('SELECT data FROM workbench_workspaces')).map(r => JSON.parse(r.data) as Workspace).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  createWorkspace(workspace: Workspace, actor: Actor): Promise<Workspace> {
    return this.serial(() => this.transaction(async () => {
      await this.run('INSERT INTO workbench_workspaces VALUES(?,?,?)', [workspace.id, workspace.version, JSON.stringify(workspace)]);
      const change = await this.record({ entity: 'workspace', entityId: workspace.id, kind: 'created', actor, version: workspace.version });
      return { value: workspace, change };
    }));
  }
  updateWorkspace(id: string, baseVersion: number | undefined, actor: Actor, kind: string, transform: (current: Workspace) => Workspace): Promise<Workspace> {
    return this.serial(() => this.transaction(async () => {
      const current = await this.readWorkspace(id);
      if (baseVersion !== undefined && baseVersion !== current.version)
        throw new AppError('VERSION_CONFLICT', '内容已被其他入口更新，请读取新版本后合并', 409, { current });
      const next = { ...transform(current), version: current.version + 1, updatedAt: new Date().toISOString() };
      await this.run('UPDATE workbench_workspaces SET version=?,data=? WHERE id=?', [next.version, JSON.stringify(next), id]);
      const change = await this.record({ entity: 'workspace', entityId: id, kind, actor, version: next.version });
      return { value: next, change };
    }));
  }
  listJobs(workspaceId?: string): Promise<Job[]> {
    return this.serial(async () => {
      const rows = await this.all<{data: string}>(`SELECT data FROM workbench_jobs${workspaceId ? ' WHERE workspace_id=?' : ''} ORDER BY rowid DESC`, workspaceId ? [workspaceId] : []);
      return rows.map(r => JSON.parse(r.data) as Job);
    });
  }
  getJob(id: string): Promise<Job> {
    return this.serial(async () => {
      const [row] = await this.all<{data: string}>('SELECT data FROM workbench_jobs WHERE id=?', [id]);
      if (!row) throw new AppError('NOT_FOUND', '任务不存在', 404);
      return JSON.parse(row.data) as Job;
    });
  }
  putJob(job: Job): Promise<Job> {
    return this.serial(() => this.transaction(async () => {
      await this.run(`INSERT INTO workbench_jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, [job.id, job.workspaceId, job.kind, job.idempotencyKey, JSON.stringify(job)]);
      const change = await this.record({ entity: 'job', entityId: job.id, kind: job.status, actor: job.actor });
      return { value: job, change };
    }));
  }
  changes(after = 0): Promise<Change[]> {
    return this.serial(async () => (await this.all<{id:number;data:string}>('SELECT id,data FROM workbench_changes WHERE id>? ORDER BY id LIMIT 1000', [after])).map(r => ({ ...JSON.parse(r.data), id: r.id }) as Change));
  }
  getSettings(): Promise<Settings> {
    return this.serial(async () => JSON.parse((await this.all<{data:string}>('SELECT data FROM workbench_settings WHERE id=1'))[0].data) as Settings);
  }
  setSettings(settings: Settings, actor: Actor): Promise<Settings> {
    return this.serial(() => this.transaction(async () => {
      await this.run('UPDATE workbench_settings SET data=? WHERE id=1', [JSON.stringify(settings)]);
      const change = await this.record({ entity:'settings', entityId:'settings',kind:'updated',actor });
      return { value: settings, change };
    }));
  }
  close(): Promise<void> {
    return this.serial(() => new Promise((resolve, reject) => this.db.close(err => err ? reject(err) : resolve())));
  }
}
