import { createHash, randomUUID } from 'node:crypto';
import type { Actor, Job, Memo, Workspace } from '../shared/contracts.js';
import type { AIProvider, FlomoProvider } from './provider-types.js';
import { AppError } from './errors.js';
import { Store } from './store.js';

export function sameMemo(a: Memo, b: Memo): boolean {
  return a.content === b.content && a.updated_at === b.updated_at && JSON.stringify(a.tags) === JSON.stringify(b.tags);
}

export class WorkbenchService {
  private locks = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  constructor(readonly store: Store, readonly flomo: FlomoProvider, readonly ai?: AIProvider) {}

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).then(operation);
    const settled = result.catch(() => undefined);
    this.locks.set(id, settled);
    try { return await result; }
    finally { if (this.locks.get(id) === settled) this.locks.delete(id); }
  }
  private background(work: () => Promise<void>): void {
    const task = Promise.resolve().then(work).catch(error => {
      // Store failures must not become unhandled rejections. Jobs are recovered on restart.
      process.stderr.write(`Workbench background task failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
  async settle(): Promise<void> { await Promise.all([...this.tasks]); }
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await this.settle();
  }
  async recover(): Promise<void> {
    for (const job of await this.store.listJobs()) {
      if (job.status !== 'running') continue;
      await this.store.putJob({ ...job, status: job.kind === 'publish' ? 'uncertain' : 'failed',
        error: job.kind === 'publish' ? '服务曾中断，请核对远端写回结果；不会自动重试' : '服务曾中断，请重新发起生成', updatedAt: new Date().toISOString() });
    }
  }
  async createWorkspace(memoId: string, title: string | undefined, actor: Actor): Promise<Workspace> {
    const source = await this.flomo.get(memoId);
    const now = new Date().toISOString();
    return this.store.createWorkspace({ id: randomUUID(), memoId, title: title ?? (source.content.replace(/#[^\s]+/g,'').trim().split('\n')[0].slice(0,80) || '未命名笔记'),
      source, remote: null, sourceChanged: false, draft: source.content, version: 1,
      materials: [], messages: [], createdAt: now, updatedAt: now, lastCheckedAt: now }, actor);
  }
  async refresh(id: string, actor: Actor): Promise<Workspace> {
    return this.locked(id, async () => {
      const workspace = await this.store.getWorkspace(id);
      const remote = await this.flomo.get(workspace.memoId);
      return this.store.updateWorkspace(id, undefined, actor, 'refreshed', current => ({ ...current, remote,
        sourceChanged: !sameMemo(current.source, remote), lastCheckedAt: new Date().toISOString() }));
    });
  }
  async rebase(id: string, baseVersion: number, actor: Actor): Promise<Workspace> {
    return this.locked(id, async () => {
      const pending = (await this.store.listJobs(id)).find(job => job.kind === 'publish' && ['running','uncertain'].includes(job.status));
      if (pending) throw new AppError('PUBLISH_PENDING', '请先核对正在进行的写回任务', 409, { job: pending });
      return this.store.updateWorkspace(id, baseVersion, actor, 'rebased', current => {
        if (!current.remote) throw new AppError('REFRESH_REQUIRED', '请先刷新远端原文，再确认合并');
        return { ...current, source: current.remote, remote: null, sourceChanged: false };
      });
    });
  }
  async setMaterials(id: string, memoIds: string[], baseVersion: number, actor: Actor): Promise<Workspace> {
    const current = await this.store.getWorkspace(id);
    this.checkVersion(current, baseVersion);
    const materials: Memo[] = [];
    for (const memoId of [...new Set(memoIds)]) if (memoId !== current.memoId) materials.push(await this.flomo.get(memoId));
    return this.store.updateWorkspace(id, baseVersion, actor, 'materials', value => ({ ...value, materials }));
  }
  private checkVersion(workspace: Workspace, version: number): void {
    if (workspace.version !== version) throw new AppError('VERSION_CONFLICT', '内容已被其他入口更新，请读取新版本后合并', 409, { current: workspace });
  }
  private requestHash(kind: string, version: number, prompt?: string): string {
    return createHash('sha256').update(JSON.stringify({kind, version, prompt})).digest('hex');
  }
  private async existingJob(id: string, kind: Job['kind'], key: string, hash: string): Promise<Job | undefined> {
    const job = (await this.store.listJobs(id)).find(value => value.kind === kind && value.idempotencyKey === key);
    if (job && (job as Job & {requestHash?: string}).requestHash !== hash)
      throw new AppError('IDEMPOTENCY_CONFLICT', '同一个请求标识不能用于不同内容，请使用新的标识', 409);
    return job;
  }
  async generate(id: string, prompt: string, baseVersion: number, key: string, actor: Actor): Promise<Job> {
    return this.locked(id, async () => {
      const hash = this.requestHash('ai', baseVersion, prompt);
      const existing = await this.existingJob(id, 'ai', key, hash);
      if (existing) return existing;
      if (!this.ai) throw new AppError('AI_NOT_CONFIGURED', '尚未配置 AI API；仍可通过 CLI 或 Codex 编辑草稿', 503);
      const current = await this.store.getWorkspace(id);
      this.checkVersion(current, baseVersion);
      if ((await this.store.listJobs(id)).some(job => job.kind === 'ai' && job.status === 'running'))
        throw new AppError('AI_PENDING', '此会话已有生成任务，请等待完成', 409);
      const now = new Date().toISOString();
      let job: Job & {requestHash: string} = { id: randomUUID(), workspaceId: id, kind:'ai', status:'running', actor,
        text:'', error:null, createdAt:now, updatedAt:now, idempotencyKey:key, baseVersion, requestHash:hash };
      await this.store.updateWorkspace(id, baseVersion, actor, 'message', workspace => ({ ...workspace,
        messages: [...workspace.messages, { id: randomUUID(), role:'user', content:prompt, createdAt:now, actor }] }));
      await this.store.putJob(job);
      this.background(async () => {
        const controller = new AbortController();
        this.controllers.add(controller);
        let partial = '';
        let lastFlush = 0;
        try {
          const text = await this.ai!.generate(current, prompt, async chunk => {
            partial += chunk;
            if (Date.now() - lastFlush > 200) {
              lastFlush = Date.now();
              job = { ...job, text:partial, updatedAt:new Date().toISOString() };
              await this.store.putJob(job);
            }
          }, controller.signal);
          await this.store.updateWorkspace(id, undefined, actor, 'message', workspace => ({ ...workspace,
            messages: [...workspace.messages, { id:randomUUID(), role:'assistant', content:text, createdAt:new Date().toISOString(), actor }] }));
          job = { ...job, status:'succeeded', text, updatedAt:new Date().toISOString() };
        } catch (error) {
          job = { ...job, status:'failed', text:partial, error: message(error), updatedAt:new Date().toISOString() };
        } finally { this.controllers.delete(controller); }
        await this.store.putJob(job);
      });
      return job;
    });
  }
  async publish(id: string, baseVersion: number, key: string, actor: Actor): Promise<Job> {
    return this.locked('publish-global', () => this.locked(id, async () => {
      const hash = this.requestHash('publish', baseVersion);
      const existing = await this.existingJob(id, 'publish', key, hash);
      if (existing) return existing;
      const workspace = await this.store.getWorkspace(id);
      this.checkVersion(workspace, baseVersion);
      const pending = (await this.store.listJobs()).find(job => job.kind === 'publish' && ['running','uncertain'].includes(job.status));
      // Only one remote write at a time, including other sessions for the same memo.
      if (pending) throw new AppError('PUBLISH_PENDING', '请先等待或核对此前的写回结果', 409, { job:pending });
      if (!workspace.draft.trim()) throw new AppError('EMPTY_DRAFT', '不能写回空草稿');
      const now = new Date().toISOString();
      const job: Job & {requestHash:string} = { id:randomUUID(), workspaceId:id, kind:'publish', status:'running', actor,
        text:'', error:null, createdAt:now, updatedAt:now, idempotencyKey:key, baseVersion, targetContent:workspace.draft, requestHash:hash };
      await this.store.putJob(job);
      this.background(() => this.runPublish(job, workspace));
      return job;
    }));
  }
  private async runPublish(job: Job, workspace: Workspace): Promise<void> {
    let attemptedWrite = false;
    try {
      const remote = await this.flomo.get(workspace.memoId);
      if (!sameMemo(workspace.source, remote)) {
        await this.store.updateWorkspace(workspace.id, undefined, job.actor, 'remote-conflict', current => ({ ...current, remote, sourceChanged:true, lastCheckedAt:new Date().toISOString() }));
        throw new AppError('REMOTE_CONFLICT', 'flomo 原文已变化，请比较并确认新基线后再写回', 409);
      }
      // Updates to the draft during the read must not silently publish the previous version.
      this.checkVersion(await this.store.getWorkspace(workspace.id), job.baseVersion);
      attemptedWrite = true;
      const published = await this.flomo.update(workspace.memoId, job.targetContent!, remote.updated_at, remote.content);
      if (published.content !== job.targetContent)
        throw new AppError('PUBLICATION_UNCONFIRMED', '远端返回内容与草稿不一致，请核对写回结果', 409);
      await this.acceptPublished(job, published);
      await this.store.putJob({ ...job, status:'succeeded', text:'已写回 flomo', updatedAt:new Date().toISOString() });
    } catch (error) {
      await this.store.putJob({ ...job, status:attemptedWrite ? 'uncertain' : 'failed', error:message(error), updatedAt:new Date().toISOString() });
    }
  }
  private async acceptPublished(job: Job, source: Memo): Promise<void> {
    await this.store.updateWorkspace(job.workspaceId, undefined, job.actor, 'published', current => ({ ...current,
      // Newer local edits remain intact even if remote publication took time.
      source, remote:null, sourceChanged:false, lastCheckedAt:new Date().toISOString() }));
  }
  async reconcile(id: string): Promise<Job> {
    const existing = await this.store.getJob(id);
    return this.locked(existing.workspaceId, async () => {
      const job = await this.store.getJob(id);
      if (job.kind !== 'publish' || job.status !== 'uncertain') return job;
      const workspace = await this.store.getWorkspace(job.workspaceId);
      const remote = await this.flomo.get(workspace.memoId);
      const matched = remote.content === job.targetContent;
      if (matched) await this.acceptPublished(job, remote);
      else await this.store.updateWorkspace(workspace.id, undefined, job.actor, 'refreshed', current => ({ ...current, remote,
        sourceChanged:!sameMemo(current.source, remote), lastCheckedAt:new Date().toISOString() }));
      return this.store.putJob({ ...job, status:matched ? 'succeeded' : 'uncertain', text:matched ? '已核对：远端内容与草稿一致' : '',
        error:matched ? null : '远端内容与本次草稿不一致，原请求仍可能延迟完成；未重试。请在 flomo 人工核对', updatedAt:new Date().toISOString() });
    });
  }
  async abandon(id: string, baseVersion: number, actor: Actor): Promise<Job> {
    const existing = await this.store.getJob(id);
    return this.locked(existing.workspaceId, async () => {
      const job = await this.store.getJob(id);
      if (job.kind !== 'publish' || job.status !== 'uncertain') throw new AppError('INVALID_JOB_STATE', '只有结果不明的写回任务可以结束跟踪', 409);
      const workspace = await this.store.getWorkspace(job.workspaceId);
      this.checkVersion(workspace,baseVersion);
      const remote = await this.flomo.get(workspace.memoId);
      await this.store.updateWorkspace(workspace.id,baseVersion,actor,'publication-abandoned', current => ({...current,
        remote,sourceChanged:!sameMemo(current.source,remote),lastCheckedAt:new Date().toISOString()}));
      return this.store.putJob({...job,status:'failed',error:'用户人工核对后结束跟踪；未重新发送写操作，原请求仍可能延迟完成',updatedAt:new Date().toISOString()});
    });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
