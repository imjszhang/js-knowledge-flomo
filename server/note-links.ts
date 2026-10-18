import { createHash, randomUUID } from 'node:crypto';
import type { Actor, Job, Memo } from '../shared/contracts.js';
import { noteLinkCreateSchema, noteLinkInputSchema, type NoteLinkCreateInput, type NoteLinkInput, type NoteLinkPreview, type NoteLinkStep } from '../shared/note-links.js';
import type { FlomoProvider } from './provider-types.js';
import { Store } from './store.js';
import { AppError } from './errors.js';
import { memoLinksTo } from './memo-links.js';
export { memoLinksTo } from './memo-links.js';

const labels = {support:'支持',counterpoint:'不同观点',example:'例子',background:'背景'};
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = (error:unknown) => error instanceof Error ? error.message : String(error);
const pendingWrite = (job:Job) => ['publish','link'].includes(job.kind) && ['running','uncertain'].includes(job.status);
type WriteLock = <T>(operation:() => Promise<T>) => Promise<T>;

export class NoteLinkService {
  private tasks = new Set<Promise<void>>();
  constructor(private store:Store, private flomo:FlomoProvider, private writeLock:WriteLock) {}

  private async completeMemo(id:string):Promise<Memo> {
    const memo = await this.flomo.get(id);
    if (memo.id !== id) throw new AppError('MEMO_IDENTITY_MISMATCH','读取到的笔记与请求不一致，未修改内容',502);
    if (memo.content_truncated || !memo.content.trim()) throw new AppError('MEMO_CONTENT_UNAVAILABLE','需要两条笔记的完整正文才能建立关联',422);
    if (memo.content.length > 500_000) throw new AppError('MEMO_TOO_LONG','笔记正文过长，无法安全建立关联',422);
    return memo;
  }
  private step(before:Memo, linkedMemoId:string, input:NoteLinkInput, reverse = false):NoteLinkStep {
    const alreadyLinked = memoLinksTo(before,linkedMemoId);
    const reason = input.reason ? `\n关联理由：${input.reason}` : '';
    const label = reverse ? `被关联笔记（原笔记将本笔记用作${labels[input.relation]}）` : `关联笔记（${labels[input.relation]}）`;
    const afterContent = alreadyLinked ? before.content : `${before.content}\n\n${label}：https://v.flomoapp.com/mine/?memo_id=${encodeURIComponent(linkedMemoId)}${reason}`;
    if (afterContent.length > 500_000) throw new AppError('MEMO_TOO_LONG','添加关联后的笔记正文过长',422);
    return {memoId:before.id,linkedMemoId,before,afterContent,alreadyLinked,status:'pending'};
  }
  async preview(id:string, raw:NoteLinkInput):Promise<NoteLinkPreview> {
    const input = noteLinkInputSchema.parse(raw);
    const workspace = await this.store.getWorkspace(id);
    this.checkVersion(workspace.version,input.baseVersion);
    if (workspace.memoId === input.targetMemoId) throw new AppError('SELF_LINK','请选择另一条笔记，不能关联自身',400);
    const [sourceMemo,targetMemo] = await Promise.all([this.completeMemo(workspace.memoId),this.completeMemo(input.targetMemoId)]);
    this.checkVersion((await this.store.getWorkspace(id)).version,input.baseVersion);
    const steps = [this.step(sourceMemo,targetMemo.id,input)];
    if (input.direction === 'bidirectional') steps.push(this.step(targetMemo,sourceMemo.id,input,true));
    const snapshot = {workspaceId:id,sourceMemo,targetMemo,input,steps};
    return {...snapshot,previewHash:hash(snapshot)};
  }
  async list(id:string):Promise<Job[]> {
    const {memoId} = await this.store.getWorkspace(id);
    return (await this.store.listJobs()).filter(job => job.kind === 'link' && job.link &&
      (job.link.sourceMemoId === memoId || job.link.input.targetMemoId === memoId));
  }
  async create(id:string, raw:NoteLinkCreateInput, actor:Actor):Promise<Job> {
    const parsed = noteLinkCreateSchema.parse(raw);
    const {previewHash,idempotencyKey,...input} = parsed;
    const requestHash = hash(parsed);
    return this.writeLock(async () => {
      const existing = (await this.store.listJobs(id)).find(job => job.kind === 'link' && job.idempotencyKey === idempotencyKey);
      if (existing) {
        if ((existing as Job & {requestHash?:string}).requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT','同一个请求标识不能用于不同关联，请使用新的标识',409);
        return existing;
      }
      const pending = (await this.store.listJobs()).find(pendingWrite);
      if (pending) throw new AppError('PUBLISH_PENDING','请先等待或核对此前的写回或关联结果',409,{job:pending});
      const preview = await this.preview(id,input);
      if (preview.previewHash !== previewHash) throw new AppError('LINK_PREVIEW_STALE','笔记或关联说明已变化，请重新预览后确认',409);
      const now = new Date().toISOString();
      const job:Job & {requestHash:string} = {id:randomUUID(),workspaceId:id,kind:'link',status:'running',actor,text:'',error:null,
        createdAt:now,updatedAt:now,idempotencyKey,baseVersion:input.baseVersion,requestHash,
        link:{sourceMemoId:preview.sourceMemo.id,input,previewHash,steps:preview.steps}};
      await this.store.putJob(job);
      const task = Promise.resolve().then(() => this.run(job)).catch(error => {
        process.stderr.write(`Note link task failed: ${message(error)}\n`);
      });
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
      return job;
    });
  }
  private checkVersion(actual:number, expected:number):void {
    if (actual !== expected) throw new AppError('VERSION_CONFLICT','内容已被其他入口更新，请读取新版本后重新预览',409);
  }
  private async save(job:Job, steps:NoteLinkStep[], status:Job['status'] = job.status, error:string|null = null):Promise<Job> {
    return this.store.putJob({...job,link:{...job.link!,steps},status,error,updatedAt:new Date().toISOString(),
      text:status === 'succeeded' ? (steps.every(step => step.alreadyLinked) ? '笔记已有关联，无需重复添加' : '已建立笔记关联') : job.text});
  }
  private async run(original:Job):Promise<void> {
    let job = original;
    let steps = job.link!.steps;
    let attempted = false;
    let index = 0;
    try {
      this.checkVersion((await this.store.getWorkspace(job.workspaceId)).version,job.baseVersion);
      for (; index < steps.length; index++) {
        const step = steps[index];
        const fresh = await this.completeMemo(step.memoId);
        if (hash(fresh) !== hash(step.before)) throw new AppError('LINK_PREVIEW_STALE','笔记在确认后发生变化，已停止后续关联，请重新核对',409);
        if (step.alreadyLinked) {
          if (!fresh.linked_memos.includes(step.linkedMemoId)) throw new AppError('LINK_UNCONFIRMED','原文已包含笔记链接，但 flomo 关联尚未确认；未重复添加，请核对结果',409);
          steps = steps.map((value,i) => i === index ? {...value,status:'verified',resultMemo:fresh} : value);
          job = await this.save(job,steps);
          await this.syncMemo(fresh,job.actor);
          continue;
        }
        steps = steps.map((value,i) => i === index ? {...value,status:'writing'} : value);
        job = await this.save(job,steps);
        attempted = true;
        await this.flomo.update(step.memoId,step.afterContent,fresh.updated_at,fresh.content);
        const readback = await this.completeMemo(step.memoId);
        if (readback.content !== step.afterContent || !readback.linked_memos.includes(step.linkedMemoId))
          throw new AppError('LINK_UNCONFIRMED','已发送关联，但远端内容尚未核对一致；请核对结果，勿重复提交',409);
        steps = steps.map((value,i) => i === index ? {...value,status:'verified',resultMemo:readback} : value);
        job = await this.save(job,steps);
        await this.syncMemo(readback,job.actor);
      }
      await this.save(job,steps,'succeeded');
    } catch (error) {
      const unconfirmed = error instanceof AppError && error.code === 'LINK_UNCONFIRMED';
      steps = steps.map((step,i) => i === index ? {...step,status:step.status === 'verified' ? 'verified' : step.status === 'writing' || unconfirmed ? 'uncertain' : 'failed',error:message(error)} : step);
      await this.save(job,steps,attempted || unconfirmed ? 'uncertain' : 'failed',message(error));
    }
  }
  /** Refresh snapshots without moving the source baseline or overwriting any local draft. */
  private async syncMemo(memo:Memo, actor:Actor):Promise<void> {
    for (const workspace of await this.store.listWorkspaces()) {
      if (workspace.memoId !== memo.id && !workspace.materials.some(item => item.id === memo.id) &&
        !workspace.materialCandidates?.some(item => item.memo.id === memo.id)) continue;
      await this.store.updateWorkspace(workspace.id,undefined,actor,'note-link',current => ({...current,
        ...(current.memoId === memo.id ? {remote:memo,sourceChanged:current.source.content !== memo.content || current.source.updated_at !== memo.updated_at || JSON.stringify(current.source.tags) !== JSON.stringify(memo.tags),lastCheckedAt:new Date().toISOString()} : {}),
        materials:current.materials.map(item => item.id === memo.id ? memo : item),
        materialCandidates:current.materialCandidates?.map(item => item.memo.id === memo.id ? {...item,memo} : item),
      }), '已同步笔记关联，保留本地草稿');
    }
  }
  async reconcile(id:string):Promise<Job> {
    return this.writeLock(async () => {
      let job = await this.store.getJob(id);
      if (job.kind !== 'link' || job.status !== 'uncertain' || !job.link) return job;
      const steps:NoteLinkStep[] = [];
      let synchronizationFailed = false;
      for (const step of job.link.steps) {
        let next:NoteLinkStep;
        try {
          const remote = await this.completeMemo(step.memoId);
          const verified = (step.alreadyLinked || remote.content === step.afterContent) && remote.linked_memos.includes(step.linkedMemoId);
          next = {...step,status:verified ? 'verified' : 'uncertain',resultMemo:remote,
            error:verified ? undefined : '远端内容与预期不一致；未重新发送写操作'};
          try { await this.syncMemo(remote,job.actor); }
          catch (error) { synchronizationFailed = true; next = {...next,error:`同步本地记录失败：${message(error)}`}; }
        } catch (error) { next = {...step,status:'uncertain',error:message(error)}; }
        steps.push(next);
      }
      const allVerified = !synchronizationFailed && steps.every(step => step.status === 'verified');
      job = await this.save(job,steps,allVerified ? 'succeeded' : 'uncertain',allVerified ? null : '部分关联尚未核实；未重试，请查看每条笔记后决定是否结束跟踪');
      return job;
    });
  }
  async abandon(id:string, baseVersion:number, actor:Actor):Promise<Job> {
    return this.writeLock(async () => {
      const job = await this.store.getJob(id);
      if (job.kind !== 'link' || job.status !== 'uncertain' || !job.link) throw new AppError('INVALID_JOB_STATE','只有结果不明的关联任务可以结束跟踪',409);
      this.checkVersion((await this.store.getWorkspace(job.workspaceId)).version,baseVersion);
      // Both notes must be readable before releasing the write guard after manual review.
      const memos = await Promise.all(job.link.steps.map(step => this.completeMemo(step.memoId)));
      this.checkVersion((await this.store.getWorkspace(job.workspaceId)).version,baseVersion);
      for (const memo of memos) await this.syncMemo(memo,actor);
      return this.save({...job,actor},job.link.steps,'failed','用户人工核对后结束跟踪；已完成的关联保留，未重发写操作，原请求仍可能延迟完成');
    });
  }
  async settle():Promise<void> { await Promise.all([...this.tasks]); }
}
