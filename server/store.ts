import sqlite3 from 'sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ActiveContext, Actor, Change, DraftRevision, Job, Settings, WorkbenchView, Workspace } from '../shared/contracts.js';
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
      CREATE TABLE IF NOT EXISTS workbench_context(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_draft_revisions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workbench_draft_revisions_workspace ON workbench_draft_revisions(workspace_id);
      INSERT OR IGNORE INTO workbench_migrations VALUES(1, datetime('now'));
      INSERT OR IGNORE INTO workbench_migrations VALUES(2, datetime('now'));
    `);
    await store.run('INSERT OR IGNORE INTO workbench_settings VALUES(1, ?)', [JSON.stringify({ pinnedTags: [...pinnedTags], refreshSeconds: 0 })]);
    await store.run('INSERT OR IGNORE INTO workbench_context VALUES(1, ?)', [JSON.stringify({ workspaceId:null, view:'note', revision:0, updatedAt:new Date().toISOString() })]);
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
    return hydrateWorkspace(JSON.parse(row.data) as Workspace);
  }
  getWorkspace(id: string): Promise<Workspace> { return this.serial(() => this.readWorkspace(id)); }
  listWorkspaces(): Promise<Workspace[]> {
    return this.serial(async () => (await this.all<{data: string}>('SELECT data FROM workbench_workspaces')).map(r => hydrateWorkspace(JSON.parse(r.data) as Workspace)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  createWorkspace(workspace: Workspace, actor: Actor): Promise<Workspace> {
    return this.serial(() => this.transaction(async () => {
      workspace = hydrateWorkspace(workspace);
      await this.run('INSERT INTO workbench_workspaces VALUES(?,?,?)', [workspace.id, workspace.version, JSON.stringify(workspace)]);
      const change = await this.record({ entity: 'workspace', entityId: workspace.id, kind: 'created', actor, version: workspace.version, summary:'开始加工笔记' });
      return { value: workspace, change };
    }));
  }
  updateWorkspace(id: string, baseVersion: number | undefined, actor: Actor, kind: string, transform: (current: Workspace) => Workspace, summary?: string): Promise<Workspace> {
    return this.serial(() => this.transaction(async () => {
      const current = await this.readWorkspace(id);
      if (baseVersion !== undefined && baseVersion !== current.version)
        throw new AppError('VERSION_CONFLICT', '内容已被其他入口更新，请读取新版本后合并', 409, { current });
      const before = current.draft;
      const fromVersion = current.version;
      const next = { ...transform(current), version: fromVersion + 1, updatedAt: new Date().toISOString() };
      const description = summary?.trim().slice(0,500) || changeSummary(kind);
      await this.run('UPDATE workbench_workspaces SET version=?,data=? WHERE id=?', [next.version, JSON.stringify(next), id]);
      if (before !== next.draft) {
        const revision: DraftRevision = { id:randomUUID(), workspaceId:id, fromVersion, toVersion:next.version,
          before, after:next.draft, summary:description, actor, createdAt:next.updatedAt };
        await this.run('INSERT INTO workbench_draft_revisions VALUES(?,?,?)', [revision.id,id,JSON.stringify(revision)]);
      }
      const change = await this.record({ entity: 'workspace', entityId: id, kind, actor, version: next.version, summary:description });
      return { value: next, change };
    }));
  }
  listDraftRevisions(workspaceId: string): Promise<DraftRevision[]> {
    return this.serial(async () => {
      await this.readWorkspace(workspaceId);
      return (await this.all<{data:string}>('SELECT data FROM workbench_draft_revisions WHERE workspace_id=? ORDER BY rowid DESC LIMIT 50', [workspaceId]))
        .map(row => JSON.parse(row.data) as DraftRevision);
    });
  }
  private async readContext(): Promise<ActiveContext> {
    const [row] = await this.all<{data:string}>('SELECT data FROM workbench_context WHERE id=1');
    const current = JSON.parse(row.data) as Omit<ActiveContext,'workspace'>;
    return { ...current, workspace:current.workspaceId ? await this.readWorkspace(current.workspaceId) : null };
  }
  getContext(): Promise<ActiveContext> { return this.serial(() => this.readContext()); }
  setContext(input: {workspaceId:string|null;view:WorkbenchView;baseRevision:number}, actor: Actor): Promise<ActiveContext> {
    return this.serial(() => this.transaction(async () => {
      const current = await this.readContext();
      if (current.revision !== input.baseRevision)
        throw new AppError('CONTEXT_CONFLICT', '当前工作已在其他入口切换，请读取最新上下文后重试', 409, {current});
      const workspace = input.workspaceId ? await this.readWorkspace(input.workspaceId) : null;
      const next = { workspaceId:input.workspaceId, view:input.view, revision:current.revision+1, updatedAt:new Date().toISOString() };
      await this.run('UPDATE workbench_context SET data=? WHERE id=1', [JSON.stringify(next)]);
      const change = await this.record({entity:'context',entityId:'context',kind:'updated',actor,version:next.revision,summary:'切换当前工作'});
      return {value:{...next,workspace},change};
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

function hydrateWorkspace(workspace: Workspace): Workspace {
  return { ...workspace, goal:workspace.goal ?? '', materialCandidates:workspace.materialCandidates ?? [], collectorMaterials:workspace.collectorMaterials ?? [], decisions:workspace.decisions ?? [], analyses:workspace.analyses ?? [], noteDrafts:workspace.noteDrafts ?? [] };
}

function changeSummary(kind: string): string {
  const descriptions: Record<string,string> = { draft:'更新了草稿', goal:'更新了本次加工目标', materials:'更新了选用材料', candidates:'添加了候选材料',
    'candidate-choice':'更新了材料选择', sources:'更新了收藏原文材料', analysis:'更新了材料分析', 'analysis-card':'更新了候选卡片', discovery:'按主题查找了材料', decision:'提出了待判断的问题', 'decision-answer':'回答了待判断的问题',
    message:'更新了讨论记录', refreshed:'检查了 flomo 原文', rebased:'确认了新的原文基线', 'remote-conflict':'发现 flomo 原文变化',
    published:'已写回 flomo', 'publication-abandoned':'结束了写回结果跟踪' };
  return descriptions[kind] ?? '更新了工作内容';
}
