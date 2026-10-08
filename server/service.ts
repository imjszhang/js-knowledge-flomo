import { createHash, randomUUID } from 'node:crypto';
import type { Actor, Job, MaterialCandidate, MaterialRelation, Memo, SourceResolution, Workspace } from '../shared/contracts.js';
import type { AIProvider, FlomoProvider } from './provider-types.js';
import { extractSourceUrls, type CollectorProvider } from './collector.js';
import { AppError } from './errors.js';
import { Store } from './store.js';
import { importedDraft } from '../shared/draft-markdown.js';
import { AnalysisService } from './analysis.js';
import { NoteDraftService } from './note-drafts.js';

export function sameMemo(a: Memo, b: Memo): boolean {
  return a.content === b.content && a.updated_at === b.updated_at && JSON.stringify(a.tags) === JSON.stringify(b.tags);
}

export class WorkbenchService {
  private locks = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  readonly analysis: AnalysisService;
  readonly noteDrafts: NoteDraftService;
  constructor(readonly store: Store, readonly flomo: FlomoProvider, readonly ai?: AIProvider, readonly collector?: CollectorProvider) {
    this.analysis = new AnalysisService(store,flomo,ai);
    this.noteDrafts = new NoteDraftService(store,flomo);
  }

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
  async settle(): Promise<void> { await Promise.all([...this.tasks]); await this.analysis.settle(); await this.noteDrafts.settle(); }
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await this.analysis.close();
    await this.noteDrafts.close();
    await this.settle();
  }
  async recover(): Promise<void> {
    await this.analysis.recover();
    await this.noteDrafts.recover();
    for (const job of await this.store.listJobs()) {
      if (job.status !== 'running') continue;
      await this.store.putJob({ ...job, status: job.kind !== 'ai' ? 'uncertain' : 'failed',
        error: job.kind !== 'ai' ? '服务曾中断，请核对远端写回结果；不会自动重试' : '服务曾中断，请重新发起生成', updatedAt: new Date().toISOString() });
    }
  }
  async createWorkspace(memoId: string, title: string | undefined, actor: Actor): Promise<Workspace> {
    const source = await this.flomo.get(memoId);
    const now = new Date().toISOString();
    return this.store.createWorkspace({ id: randomUUID(), memoId, title: title ?? (source.content.replace(/#[^\s]+/g,'').trim().split('\n')[0].slice(0,80) || '未命名笔记'),
      source, remote: null, sourceChanged: false, draft: importedDraft(source.content), version: 1,
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
    const ids = [...new Set(memoIds)].filter(memoId => memoId !== current.memoId);
    if (ids.length + (current.collectorMaterials?.length ?? 0) > 30) throw new AppError('MATERIAL_LIMIT', '每次加工最多选用 30 条材料');
    const materials: Memo[] = [];
    for (const memoId of ids) materials.push(await this.flomo.get(memoId));
    return this.store.updateWorkspace(id, baseVersion, actor, 'materials', value => {
      const selected = new Map(materials.map(memo => [memo.id,memo]));
      const candidates = (value.materialCandidates ?? []).map(candidate => ({...candidate,
        memo:selected.get(candidate.memo.id) ?? candidate.memo,
        status:(selected.has(candidate.memo.id) ? 'selected' : candidate.status === 'selected' ? 'dismissed' : candidate.status) as MaterialCandidate['status'] }));
      for (const memo of materials) if (!candidates.some(candidate => candidate.memo.id === memo.id))
        candidates.push({memo,reason:'已选入本次加工',relation:'background',status:'selected'});
      this.checkCandidateLimit(candidates);
      return { ...value, materials, materialCandidates:candidates };
    }, `选用了 ${materials.length} 条材料`);
  }
  async proposeCandidates(id: string, items: {memoId:string;reason:string;relation:MaterialRelation}[], baseVersion: number, actor: Actor): Promise<Workspace> {
    const current = await this.store.getWorkspace(id);
    this.checkVersion(current,baseVersion);
    const unique = [...new Map(items.filter(item => item.memoId !== current.memoId).map(item => [item.memoId,item])).values()];
    const candidateIds = new Set([...(current.materialCandidates ?? []).map(candidate => candidate.memo.id),...unique.map(item => item.memoId)]);
    if (candidateIds.size > 100) throw new AppError('CANDIDATE_LIMIT', '每次加工最多保留 100 条候选材料');
    const incoming: MaterialCandidate[] = [];
    for (const item of unique) incoming.push({memo:await this.flomo.get(item.memoId),reason:item.reason,relation:item.relation,status:'proposed'});
    return this.store.updateWorkspace(id,baseVersion,actor,'candidates',value => {
      const candidates = new Map((value.materialCandidates ?? []).map(candidate => [candidate.memo.id,candidate]));
      for (const item of incoming) candidates.set(item.memo.id,{...item,
        status:candidates.get(item.memo.id)?.status ?? (value.materials.some(memo => memo.id === item.memo.id) ? 'selected' : 'proposed')});
      const materialCandidates = [...candidates.values()];
      this.checkCandidateLimit(materialCandidates);
      return {...value,materialCandidates,materials:value.materials.map(memo => candidates.get(memo.id)?.memo ?? memo)};
    }, `更新了 ${incoming.length} 条候选材料及推荐理由`);
  }
  chooseCandidate(id: string, memoId: string, status: MaterialCandidate['status'], baseVersion: number, actor: Actor): Promise<Workspace> {
    return this.store.updateWorkspace(id,baseVersion,actor,'candidate-choice',workspace => {
      const candidate = workspace.materialCandidates?.find(value => value.memo.id === memoId);
      if (!candidate) throw new AppError('NOT_FOUND', '候选材料不存在', 404);
      const materials = workspace.materials.filter(memo => memo.id !== memoId);
      if (status === 'selected') materials.push(candidate.memo);
      if (materials.length + (workspace.collectorMaterials?.length ?? 0) > 30) throw new AppError('MATERIAL_LIMIT', '每次加工最多选用 30 条材料');
      return {...workspace,materials,materialCandidates:workspace.materialCandidates!.map(value => value.memo.id === memoId ? {...value,status} : value)};
    }, status === 'selected' ? '选入了一条材料' : status === 'dismissed' ? '暂不采用一条材料' : '将一条材料放回候选列表');
  }
  private sourceLinks(workspace: Workspace): Map<string, string[]> {
    const links = new Map<string, string[]>();
    for (const memo of [workspace.source, ...workspace.materials]) {
      for (const url of extractSourceUrls(memo.content)) {
        const ids = links.get(url) ?? [];
        if (!ids.includes(memo.id)) ids.push(memo.id);
        links.set(url, ids);
      }
    }
    return links;
  }
  async resolveSources(id: string): Promise<SourceResolution> {
    const workspace = await this.store.getWorkspace(id);
    if (!this.collector) return { configured:false, truncated:false, items:[] };
    const links = [...this.sourceLinks(workspace)];
    const selected = links.slice(0, 20);
    const items: SourceResolution['items'] = [];
    // Bound fan-out so opening a note cannot trigger an unbounded library scan.
    for (let offset = 0; offset < selected.length; offset += 4) {
      items.push(...await Promise.all(selected.slice(offset, offset + 4).map(async ([url, memoIds]): Promise<SourceResolution['items'][number]> => {
        try {
          const articles = await this.collector!.findByUrl(url);
          return {url,memoIds,articles,status:articles.length === 1 ? 'matched' : articles.length ? 'ambiguous' : 'missing'};
        } catch {
          return {url,memoIds,articles:[],status:'unavailable',message:'暂时无法查询收藏库，请检查连接后重试'};
        }
      })));
    }
    return { configured:true, truncated:links.length > selected.length, items };
  }
  getSource(articleId: string) {
    if (!this.collector) throw new AppError('COLLECTOR_NOT_CONFIGURED', '尚未配置收藏库连接，请设置 COLLECTOR_BASE_URL', 503);
    return this.collector.get(articleId);
  }
  async attachSource(id: string, articleId: string, baseVersion: number, actor: Actor): Promise<Workspace> {
    const workspace = await this.store.getWorkspace(id);
    this.checkVersion(workspace, baseVersion);
    const previous = workspace.collectorMaterials ?? [];
    if (!previous.some(item => item.article.id === articleId) && previous.length + workspace.materials.length >= 30)
      throw new AppError('MATERIAL_LIMIT', '每次加工最多选用 30 条材料');
    const article = await this.getSource(articleId);
    if (article.contentTruncated || !article.content.trim())
      throw new AppError('COLLECTOR_CONTENT_UNAVAILABLE', '收藏记录暂无完整正文，无法加入加工材料', 422);
    const memoIds = [...new Set([...(previous.find(item => item.article.id === articleId)?.memoIds ?? []), ...(this.sourceLinks(workspace).get(article.sourceUrl) ?? [])])];
    const snapshot = {kind:'collector' as const,article,memoIds,fetchedAt:new Date().toISOString()};
    return this.store.updateWorkspace(id, baseVersion, actor, 'sources', value => ({...value,
      collectorMaterials:[...(value.collectorMaterials ?? []).filter(item => item.article.id !== articleId),snapshot],
    }), previous.some(item => item.article.id === articleId) ? '刷新了收藏原文快照' : '选入了一篇收藏原文');
  }
  detachSource(id: string, articleId: string, baseVersion: number, actor: Actor): Promise<Workspace> {
    return this.store.updateWorkspace(id,baseVersion,actor,'sources',workspace => ({...workspace,
      collectorMaterials:(workspace.collectorMaterials ?? []).filter(item => item.article.id !== articleId),
    }), '移出了一篇收藏原文');
  }
  createDecision(id: string, question: string, options: string[], baseVersion: number, actor: Actor): Promise<Workspace> {
    return this.store.updateWorkspace(id,baseVersion,actor,'decision',workspace => ({...workspace,
      decisions:[...(workspace.decisions ?? []),{id:randomUUID(),question,options,answer:null,createdAt:new Date().toISOString(),answeredAt:null}]}));
  }
  answerDecision(id: string, decisionId: string, answer: string, baseVersion: number, actor: Actor): Promise<Workspace> {
    return this.store.updateWorkspace(id,baseVersion,actor,'decision-answer',workspace => {
      if (!workspace.decisions?.some(decision => decision.id === decisionId)) throw new AppError('NOT_FOUND','待判断的问题不存在',404);
      return {...workspace,decisions:workspace.decisions.map(decision => decision.id === decisionId ? {...decision,answer,answeredAt:new Date().toISOString()} : decision)};
    });
  }
  private checkCandidateLimit(candidates: MaterialCandidate[]): void {
    if (candidates.length > 100) throw new AppError('CANDIDATE_LIMIT', '每次加工最多保留 100 条候选材料');
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
  async annotate(id: string, content: string, key: string, actor: Actor): Promise<Job> {
    return this.locked(id, async () => {
      const hash = this.requestHash('annotation', 0, content);
      const existing = await this.existingJob(id, 'annotation', key, hash);
      if (existing) return existing;
      if (!this.flomo.create) throw new AppError('CREATE_UNAVAILABLE', '当前接入不支持新建笔记', 503);
      const workspace = await this.store.getWorkspace(id);
      const now = new Date().toISOString();
      const targetContent = `${content.trim()}\n\n关联原笔记：https://v.flomoapp.com/mine/?memo_id=${encodeURIComponent(workspace.memoId)}`;
      const job: Job & {requestHash:string} = {id:randomUUID(), workspaceId:id, kind:'annotation', status:'running', actor,
        text:'', error:null, createdAt:now, updatedAt:now, idempotencyKey:key, baseVersion:workspace.version, targetContent, requestHash:hash};
      await this.store.putJob(job);
      this.background(async () => {
        try {
          const resultMemo = await this.flomo.create!(targetContent);
          const linked = resultMemo.linked_memos.includes(workspace.memoId);
          await this.store.putJob({...job, resultMemo, status:linked ? 'succeeded' : 'uncertain', text:linked ? '已创建批注并关联原笔记' : '',
            error:linked ? null : '新笔记已创建，但双链尚未确认，请打开新笔记核对，勿重复创建。', updatedAt:new Date().toISOString()});
        } catch (error) {
          await this.store.putJob({...job,status:'uncertain',error:`创建结果待核实：${message(error)}。请在 flomo 核对，勿重复创建。`,updatedAt:new Date().toISOString()});
        }
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
