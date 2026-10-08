import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, AnalysisSource, Memo, NoteDraft, Workspace } from '../shared/contracts.js';
import { noteDraftCreateSchema, noteDraftPublishSchema, noteDraftUpdateSchema } from '../shared/contracts.js';
import { analysisSources } from '../shared/analysis.js';
import { formatNoteDraft } from '../shared/note-drafts.js';
import { extractSourceUrls } from './collector.js';
import { AppError } from './errors.js';
import type { FlomoProvider } from './provider-types.js';
import { Store } from './store.js';

const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** New notes remain separate from the source note's editable draft and publication jobs. */
export class NoteDraftService {
  private locks = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<void>>();
  constructor(readonly store: Store, readonly flomo: FlomoProvider) {}

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(id) ?? Promise.resolve()).then(operation);
    const settled = task.catch(() => undefined);
    this.locks.set(id,settled);
    try { return await task; }
    finally { if (this.locks.get(id) === settled) this.locks.delete(id); }
  }
  private background(operation: () => Promise<void>): void {
    const task = Promise.resolve().then(operation).catch(() => {
      process.stderr.write('New-note publication could not persist its result.\n');
    });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
  async settle(): Promise<void> { while (this.tasks.size) await Promise.all([...this.tasks]); }
  async close(): Promise<void> { await this.settle(); }
  async recover(): Promise<void> {
    for (const workspace of await this.store.listWorkspaces()) {
      if (!workspace.noteDrafts?.some(draft => draft.status === 'publishing')) continue;
      await this.store.updateWorkspace(workspace.id,undefined,'web','note-draft-recovered',current => ({...current,
        noteDrafts:(current.noteDrafts ?? []).map(draft => draft.status === 'publishing'
          ? {...draft,status:'uncertain',updatedAt:now(),error:'服务曾中断，请在 flomo 核对创建结果；不会自动重试'} : draft),
      }),'恢复中断的新笔记创建状态');
    }
  }

  async create(id: string, input: z.infer<typeof noteDraftCreateSchema>, actor: Actor): Promise<Workspace> {
    input = noteDraftCreateSchema.parse(input);
    return this.locked(id,async () => {
      const initial = await this.store.getWorkspace(id);
      const requestHash = digest({title:input.title,content:input.content,originAnalysisId:input.originAnalysisId,baseVersion:input.baseVersion});
      const existing = initial.noteDrafts?.find(draft => draft.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT','这个请求标识已用于不同的新笔记草稿',409);
        return initial;
      }
      this.checkVersion(initial,input.baseVersion);
      if ((initial.noteDrafts?.length ?? 0) >= 50) throw new AppError('NOTE_DRAFT_LIMIT','每个工作区最多保留 50 份新笔记草稿，请新建加工会话继续',409);
      const sources = this.sources(initial,input.originAnalysisId);
      const draft: NoteDraft = {id:randomUUID(),title:input.title,content:input.content,sources,originAnalysisId:input.originAnalysisId,
        status:'draft',createdAt:now(),updatedAt:now(),actor,idempotencyKey:input.idempotencyKey,requestHash};
      return this.store.updateWorkspace(id,input.baseVersion,actor,'note-draft-created',current => ({...current,noteDrafts:[...(current.noteDrafts ?? []),draft]}),'基于当前笔记新建了独立草稿');
    });
  }
  async update(id: string, draftId: string, input: z.infer<typeof noteDraftUpdateSchema>, actor: Actor): Promise<Workspace> {
    input = noteDraftUpdateSchema.parse(input);
    return this.store.updateWorkspace(id,input.baseVersion,actor,'note-draft-updated',workspace => {
      const draft = this.draft(workspace,draftId);
      if (draft.status !== 'draft' || draft.publicationKey) throw new AppError('NOTE_DRAFT_NOT_EDITABLE','只能编辑尚未发布的新笔记草稿',409);
      return this.replace(workspace,{...draft,title:input.title,content:input.content,updatedAt:now()});
    },'保存了新笔记草稿');
  }
  async publish(id: string, draftId: string, input: z.infer<typeof noteDraftPublishSchema>, actor: Actor): Promise<Workspace> {
    input = noteDraftPublishSchema.parse(input);
    return this.locked(id,async () => {
      const initial = await this.store.getWorkspace(id);
      const draft = this.draft(initial,draftId);
      const content = formatNoteDraft(draft);
      const requestHash = digest({draftId,content});
      const previous = initial.noteDrafts?.find(item => item.publicationKey === input.idempotencyKey);
      if (previous && previous.publicationHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT','这个请求标识已用于其他新笔记',409);
      // Even a different key cannot repeat a create with a known or uncertain remote outcome.
      if (draft.publicationKey || ['publishing','published','uncertain'].includes(draft.status)) return initial;
      this.checkVersion(initial,input.baseVersion);
      if (draft.status !== 'draft') throw new AppError('NOTE_DRAFT_NOT_READY','新笔记草稿尚未准备好',409);
      if (!draft.title.trim() && !draft.content.trim()) throw new AppError('NOTE_DRAFT_EMPTY','请先填写新笔记内容，再创建到 flomo',422);
      if (content.length > 20_000) throw new AppError('NOTE_DRAFT_CONTENT_LIMIT','新笔记内容和来源链接合计超过 20,000 字符，请缩短内容',422);
      if (!this.flomo.create) throw new AppError('CREATE_UNAVAILABLE','当前 flomo 连接不支持创建笔记',503);
      const workspace = await this.store.updateWorkspace(id,input.baseVersion,actor,'note-draft-publishing',current => this.replace(current,
        {...this.draft(current,draftId),status:'publishing',publicationKey:input.idempotencyKey,publicationHash:requestHash,publicationActor:actor,updatedAt:now()}),'开始将新笔记草稿创建到 flomo');
      this.background(async () => {
        let result: Partial<NoteDraft>;
        let resultMemo: Memo | undefined;
        try {
          resultMemo = await this.flomo.create!(content);
          if (!resultMemo.id) throw new Error('missing identity');
          const createdId = resultMemo.id;
          if (draft.sources.some(source => source.kind === 'flomo' && source.id === createdId)) throw new Error('create returned a source identity');
          resultMemo = await this.flomo.get(createdId);
          const urls = new Set(extractSourceUrls(resultMemo.content));
          if (resultMemo.id !== createdId || resultMemo.content_truncated || resultMemo.content !== content || draft.sources.some(source => source.kind === 'flomo'
            ? !resultMemo!.linked_memos.includes(source.id) : !urls.has(source.url))) throw new Error('created content or sources unconfirmed');
          result = {status:'published',resultMemo,error:undefined};
        } catch {
          result = {status:'uncertain',...(resultMemo ? {resultMemo} : {}),error:'无法确认 flomo 是否已完整创建并保留来源，请在 flomo 核对；不会自动重试'};
        }
        await this.store.updateWorkspace(id,undefined,actor,'note-draft-result',current => this.replace(current,
          {...this.draft(current,draftId),...result,updatedAt:now()}),result.status === 'published' ? '已将独立草稿创建为 flomo 新笔记' : '需要核对新笔记创建结果');
      });
      return workspace;
    });
  }
  private sources(workspace: Workspace, analysisId?: string): AnalysisSource[] {
    let sources: AnalysisSource[];
    if (analysisId) {
      const analysis = workspace.analyses?.find(record => record.id === analysisId);
      if (!analysis) throw new AppError('NOT_FOUND','分析记录不存在',404);
      if (analysis.status !== 'succeeded') throw new AppError('ANALYSIS_NOT_COMPLETE','请先完成分析，再存为新笔记草稿',409);
      // Historical analysis keeps its original evidence even if the current selection has changed.
      sources = analysis.sources;
    } else {
      if ([workspace.source,...workspace.materials].some(memo => memo.content_truncated || !memo.content.trim()) ||
        (workspace.collectorMaterials ?? []).some(material => material.article.contentTruncated || !material.article.content.trim()))
        throw new AppError('FULL_CONTENT_UNAVAILABLE','选用材料缺少完整正文，请先获取全文后创建新笔记草稿',422);
      sources = analysisSources(workspace);
    }
    const rootKey = `flomo:${workspace.source.id}`;
    if (!sources.some(source => source.key === rootKey)) {
      if (workspace.source.content_truncated || !workspace.source.content.trim()) throw new AppError('FULL_CONTENT_UNAVAILABLE','当前笔记缺少完整正文，无法保留来源',422);
      sources = [...sources,...analysisSources({...workspace,materials:[],collectorMaterials:[]})];
    }
    if (sources.some(source => !source.content.trim())) throw new AppError('FULL_CONTENT_UNAVAILABLE','来源快照缺少完整正文',422);
    return structuredClone([...new Map(sources.map(source => [source.key,source])).values()]);
  }
  private draft(workspace: Workspace, id: string): NoteDraft {
    const draft = workspace.noteDrafts?.find(item => item.id === id);
    if (!draft) throw new AppError('NOT_FOUND','新笔记草稿不存在',404);
    return draft;
  }
  private replace(workspace: Workspace, draft: NoteDraft): Workspace {
    return {...workspace,noteDrafts:(workspace.noteDrafts ?? []).map(item => item.id === draft.id ? draft : item)};
  }
  private checkVersion(workspace: Workspace, baseVersion: number): void {
    if (workspace.version !== baseVersion) throw new AppError('VERSION_CONFLICT','工作区已更新，请读取新版本后重试',409,{current:workspace});
  }
}
