import { randomUUID } from "./browser-compat";
import {useEffect, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {ArrowUpRight, Check, Link2, Loader2} from 'lucide-react';
import type {Job, Memo, Workspace} from '../../shared/contracts';
import {noteLinkCreateSchema, type NoteLinkCreateInput, type NoteLinkInput, type NoteLinkPreview} from '../../shared/note-links';
import {ApiError, api, messageOf, sourceUrl} from './api';
import InlineDiff from './InlineDiff';
import Modal from './Modal';
import {markdownExcerpt} from './markdown-text';

const relationLabels: Record<NoteLinkInput['relation'], string> = {support:'支持观点',counterpoint:'不同观点',example:'具体例子',background:'补充背景'};
const stepLabels = {pending:'尚未写入',writing:'正在写入',verified:'已核实',uncertain:'待核对',failed:'未完成'};
const jobLabels = {running:'正在建立关联',succeeded:'已建立关联',uncertain:'结果待核对',failed:'关联未完成'};
type LinkForm = {reference:string;direction:NoteLinkInput['direction'];relation:NoteLinkInput['relation'];reason:string};
type LinkAttempt = {request:NoteLinkCreateInput;preview:NoteLinkPreview};

function titleOf(memo: Memo) { return markdownExcerpt(memo.content,600).split('\n').map(line => line.trim()).find(line => line && !/^#\S+(\s+#\S+)*$/.test(line))?.replace(/^\*{1,2}|\*{1,2}$/g,'').slice(0,100) || '未命名笔记'; }
function memoIdOf(reference: string) {
  let id = reference.trim();
  if (/^https?:\/\//i.test(id)) {
    const url = new URL(id);
    if (url.hostname !== 'flomoapp.com' && !url.hostname.endsWith('.flomoapp.com')) throw new Error('请粘贴 flomo 笔记链接或笔记 ID。');
    id = url.searchParams.get('memo_id') ?? '';
  }
  if (!/^[A-Za-z0-9_-]{1,500}$/.test(id)) throw new Error('没有找到有效的笔记 ID，请检查 flomo 链接。');
  return id;
}
function readSaved<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; }
  catch { return null; }
}
function loadAttempt(key:string):LinkAttempt|null {
  const saved = readSaved<LinkAttempt>(key);
  return saved && noteLinkCreateSchema.safeParse(saved.request).success && saved.preview?.steps && saved.preview?.sourceMemo && saved.preview?.targetMemo ? saved : null;
}
function saveLocal(key:string,value:unknown) { localStorage.setItem(key,JSON.stringify(value)); }
function definitiveRejection(error:unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408,425,429].includes(error.status);
}

export function NoteLinkDialog({workspace,target,flush,onClose,onUpdate}: {
  workspace:Workspace;target?:Memo;flush:()=>Promise<Workspace>;onClose:()=>void;onUpdate:(workspace:Workspace)=>void;
}) {
  const client = useQueryClient();
  const formKey = `flomo:note-link-form:${workspace.id}:${target?.id ?? 'manual'}`;
  const attemptKey = `flomo:note-link-attempt:${workspace.id}`;
  const [form,setForm] = useState<LinkForm>(() => readSaved<LinkForm>(formKey) ?? {reference:target?.id ?? '',direction:'outgoing',relation:workspace.materialCandidates?.find(item => item.memo.id === target?.id)?.relation ?? 'background',reason:''});
  const [attempt,setAttempt] = useState<LinkAttempt|null>(() => loadAttempt(attemptKey));
  const [preview,setPreview] = useState<NoteLinkPreview|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const shownPreview = attempt?.preview ?? preview;
  useEffect(() => {
    if (!attempt) return;
    let active = true;
    void api.links(workspace.id).then(jobs => {
      if (!active) return;
      const known = jobs.find(job => job.idempotencyKey === attempt.request.idempotencyKey && job.workspaceId === workspace.id);
      if (known) accept(known,attempt.request.idempotencyKey);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!busy && !attempt) return;
    const warn = (event:BeforeUnloadEvent) => { event.preventDefault();event.returnValue=''; };
    window.addEventListener('beforeunload',warn);
    return () => window.removeEventListener('beforeunload',warn);
  }, [busy,attempt]);
  function change(update:Partial<LinkForm>) {
    const next = {...form,...update};setForm(next);setPreview(null);setError('');
    try { saveLocal(formKey,next); }
    catch { setError('浏览器暂时不能保存输入，请保持本窗口打开。'); }
  }
  function clearAttempt() { localStorage.removeItem(attemptKey);setAttempt(null); }
  function accept(job:Job,expectedKey:string) {
    if (!job || typeof job.id !== 'string' || job.kind !== 'link' || job.workspaceId !== workspace.id || job.idempotencyKey !== expectedKey) {
      throw new ApiError('LINK_RESULT_UNCONFIRMED','尚未收到可核实的关联结果，已保留这次提交。请恢复同一次提交。',0);
    }
    try { clearAttempt(); } catch { setAttempt(null); }
    client.setQueryData<Job[]>(['jobs','links',workspace.id],old => {
      const previous = old?.find(item => item.id === job.id);
      const newer = previous && (previous.updatedAt > job.updatedAt || (previous.status !== 'running' && job.status === 'running')) ? previous : job;
      return [newer,...(old ?? []).filter(item => item.id !== job.id)];
    });
    void client.invalidateQueries({queryKey:['jobs']});
    void api.workspace(workspace.id).then(onUpdate).catch(() => client.invalidateQueries({queryKey:['workspace',workspace.id]}));
    onClose();
  }
  async function prepare() {
    if (busy || attempt) return;
    setBusy(true);setError('');setPreview(null);
    try {
      const targetMemoId = memoIdOf(form.reference);
      if (targetMemoId === workspace.memoId) throw new Error('请选择另一条笔记，不能关联当前笔记本身。');
      const saved = await flush();
      const result = await api.previewLink(workspace.id,{targetMemoId,direction:form.direction,relation:form.relation,reason:form.reason.trim(),baseVersion:saved.version});
      setPreview(result);
    } catch(error) { setError(messageOf(error));void client.invalidateQueries({queryKey:['workspace',workspace.id]}); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy || (!preview && !attempt)) return;
    setBusy(true);setError('');
    let next = attempt;
    try {
      if (!next && preview) {
        next = {preview,request:{...preview.input,previewHash:preview.previewHash,idempotencyKey:randomUUID()}};
        // Persist synchronously before a remote write so refreshes can only resume this exact request.
        saveLocal(attemptKey,next);setAttempt(next);
      }
      if (!next) return;
      accept(await api.createLink(workspace.id,next.request),next.request.idempotencyKey);
    } catch(error) {
      if (definitiveRejection(error)) {
        try { clearAttempt(); } catch { /* Retain the same key if storage is unavailable. */ }
        setPreview(null);
        setError(`${messageOf(error)} 请重新预览后再确认。`);
      } else {
        setError(messageOf(error));
      }
      void client.invalidateQueries({queryKey:['jobs']});
      void client.invalidateQueries({queryKey:['workspace',workspace.id]});
    } finally { setBusy(false); }
  }
  const stale = !!preview && preview.input.baseVersion !== workspace.version;
  return <Modal title="建立笔记关联" wide onClose={() => {if (!busy) onClose();}}>
    <p className="modal-description">在已有 flomo 笔记正文中添加链接。先查看具体改动，再确认写入。</p>
    {attempt ? <div className="notice" role="status"><strong>上次提交的结果尚未确认</strong><p>提交内容与请求编号已保留。可以恢复这次提交，或关闭后在关联记录中核对；恢复时不会发起另一份重复请求。</p></div> : <div className="note-link-form">
      <div className="note-link-source"><span>当前笔记</span><strong>{titleOf(workspace.source)}</strong></div>
      <label>关联到哪条笔记<input aria-label="关联到哪条笔记" value={form.reference} placeholder="粘贴 flomo 笔记链接或笔记 ID" onChange={event => change({reference:event.target.value})} disabled={busy} autoFocus={!target}/></label>
      {target && form.reference === target.id && <p className="note-link-target-name">{titleOf(target)}</p>}
      <fieldset disabled={busy} className="note-link-directions"><legend>关联方式</legend>
        <label><input type="radio" name="note-link-direction" value="outgoing" checked={form.direction === 'outgoing'} onChange={() => change({direction:'outgoing'})}/><span><strong>从当前笔记链接过去</strong><small>在当前笔记添加目标链接</small></span></label>
        <label><input type="radio" name="note-link-direction" value="bidirectional" checked={form.direction === 'bidirectional'} onChange={() => change({direction:'bidirectional'})}/><span><strong>两条笔记互相链接</strong><small>分别修改两条笔记，添加对方链接</small></span></label>
      </fieldset>
      <label>这条材料与当前笔记的关系<select aria-label="关联类型" value={form.relation} disabled={busy} onChange={event => change({relation:event.target.value as NoteLinkInput['relation']})}>{Object.entries(relationLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>为什么关联（可选）<textarea aria-label="关联说明" value={form.reason} disabled={busy} onChange={event => change({reason:event.target.value})} maxLength={2000} rows={3} placeholder="用一句话说明它们如何连接，例如：这条笔记为当前判断提供了一个具体例子。"/><small>你填写的说明会和链接一起写入笔记。</small></label>
    </div>}
    {shownPreview && <section className="note-link-preview" aria-label="笔记关联修改预览"><h3>{attempt ? '已确认的改动' : '确认以下改动'}</h3><div className="note-link-preview-target"><span>关联对象：</span>{sourceUrl(shownPreview.targetMemo.url) ? <a className="text-link" href={sourceUrl(shownPreview.targetMemo.url)} target="_blank" rel="noopener noreferrer">{titleOf(shownPreview.targetMemo)}<ArrowUpRight size={12}/></a> : titleOf(shownPreview.targetMemo)}</div><p className="scope-notice">{shownPreview.input.direction === 'bidirectional' ? '两条笔记会分别写入并核实；若中途停止，可在记录中查看每一条的结果。' : '将在当前笔记末尾添加关联。'}</p>{shownPreview.steps.map(step => <div className="note-link-preview-step" key={step.memoId}><div className="note-link-step-heading"><h4>{titleOf(step.before)}</h4>{sourceUrl(step.before.url) && <a className="text-link" href={sourceUrl(step.before.url)} target="_blank" rel="noopener noreferrer">打开原笔记<ArrowUpRight size={12}/></a>}</div>{step.alreadyLinked ? <p className="selected-label"><Check size={13}/>已有此链接，无需重复添加</p> : <InlineDiff before={step.before.content} after={step.afterContent}/>}</div>)}</section>}
    {stale && !attempt && <p className="notice">工作区已更新。你的输入已保留，请重新预览最新内容。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>{attempt ? '稍后核对' : '取消'}</button>{attempt ? <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? <><Loader2 size={14} className="spin"/>正在恢复…</> : '恢复这次提交'}</button> : preview && !stale ? <><button className="text-button" disabled={busy} onClick={() => setPreview(null)}>返回编辑</button><button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : shownPreview?.steps.every(step => step.alreadyLinked) ? '确认已有链接' : form.direction === 'bidirectional' ? '确认写入两条笔记' : '确认写入当前笔记'}</button></> : <button className="button primary" disabled={busy || !form.reference.trim()} onClick={() => void prepare()}>{busy ? '正在读取笔记…' : stale ? '重新预览改动' : '预览改动'}</button>}</div>
  </Modal>;
}

export function NoteLinksPanel({workspace,jobs,onOpen,onUpdate}: {workspace:Workspace;jobs:Job[];onOpen:(target?:Memo)=>void;onUpdate:(workspace:Workspace)=>void}) {
  const client = useQueryClient();
  const [busy,setBusy] = useState<string|null>(null);
  const [error,setError] = useState('');
  const [abandon,setAbandon] = useState<Job|null>(null);
  const [acknowledged,setAcknowledged] = useState(false);
  const links = jobs.filter(job => job.kind === 'link');
  const active = links.filter(job => job.status === 'running' || job.status === 'uncertain');
  const history = links.filter(job => job.status !== 'running' && job.status !== 'uncertain');
  async function recover(job:Job,stop=false) {
    if (busy) return;
    setBusy(job.id);setError('');
    try {
      if (stop) {
        const origin = await api.workspace(job.workspaceId);
        await api.abandon(job.id,origin.version);
        setAbandon(null);setAcknowledged(false);
      } else await api.reconcile(job.id);
      await client.invalidateQueries({queryKey:['jobs']});
      onUpdate(await api.workspace(workspace.id));
    } catch(error) { setError(messageOf(error)); }
    finally { setBusy(null); }
  }
  function renderJob(job:Job,expanded:boolean) {
    const otherId = job.link?.sourceMemoId === workspace.memoId ? job.link.input.targetMemoId : job.link?.sourceMemoId;
    const other = job.link?.steps.flatMap(step => [step.before, ...(step.resultMemo ? [step.resultMemo] : [])]).find(memo => memo.id === otherId)
      ?? workspace.materials.find(memo => memo.id === otherId) ?? workspace.materialCandidates?.find(candidate => candidate.memo.id === otherId)?.memo;
    const heading = <><span className="note-link-record-title">{other ? titleOf(other) : `笔记 ${otherId ?? ''}`}<small>{job.link?.input.direction === 'bidirectional' ? '互相链接' : job.link?.sourceMemoId === workspace.memoId ? '链接到另一条笔记' : '另一条笔记链接到这里'}</small></span><span className={`note-link-status ${job.status}`}>{job.status === 'running' && <Loader2 size={13} className="spin"/>}{jobLabels[job.status]}</span></>;
    const body = <div className="note-link-record-body">
      {job.link?.input.reason && <p className="note-link-reason">{relationLabels[job.link.input.relation]} · {job.link.input.reason}</p>}
      <ul className="note-link-steps">{job.link?.steps.map(step => <li key={step.memoId}><span>{titleOf(step.before)}</span><span>{stepLabels[step.status]}{step.alreadyLinked ? ' · 原有链接' : ''}</span>{sourceUrl(step.before.url) && <a href={sourceUrl(step.before.url)} target="_blank" rel="noopener noreferrer" className="text-link">查看笔记<ArrowUpRight size={12}/></a>}{step.error && <p>{step.error}</p>}</li>)}</ul>
      {job.status === 'uncertain' && <p className="scope-notice">可能已有部分链接写入。核对只会重新读取笔记，不会继续或重复写入。</p>}
      {job.error && <p className="error-box">{job.error}</p>}
      {job.status === 'uncertain' && <div className="inline-actions"><button className="button secondary small" disabled={!!busy} onClick={() => void recover(job)}>{busy === job.id ? '正在核对…' : '核对实际结果'}</button><button className="text-button subdued" disabled={!!busy} onClick={() => {setAbandon(job);setAcknowledged(false);setError('');}}>结束此次操作…</button></div>}
      <details className="note-link-change-details"><summary>查看原计划改动</summary>{job.link?.steps.map(step => <div key={step.memoId}><h4>{titleOf(step.before)}</h4><InlineDiff before={step.before.content} after={step.afterContent}/></div>)}</details>
      <p className="note-link-record-meta">{new Date(job.createdAt).toLocaleString('zh-CN')} · {job.actor === 'web' ? '网页' : job.actor === 'cli' ? 'CLI' : 'MCP'}</p>
    </div>;
    return expanded ? <article className="note-link-record" key={job.id}><div className="note-link-record-heading">{heading}</div>{body}</article> : <details className="note-link-record" key={job.id}><summary>{heading}</summary>{body}</details>;
  }
  return <section className="note-links-panel" aria-label="笔记关联"><div className="note-links-heading"><h3><Link2 size={15}/>笔记关联</h3><button className="text-button" onClick={() => onOpen()}>建立关联</button></div><p className="scope-notice">把联系写入 flomo 笔记；选用材料后，仍可单独决定是否建立链接。</p>
    {active.map(job => renderJob(job,true))}
    {!!history.length && <details className="note-links-history"><summary>关联记录 · {history.length}{history.some(job => job.status === 'failed') && ` · ${history.filter(job => job.status === 'failed').length} 条未完成`}</summary>{history.map(job => renderJob(job,false))}</details>}
    {error && !abandon && <p className="error-box" role="alert">{error}</p>}
    {abandon && <Modal title="结束此次关联操作" onClose={() => {if(!busy)setAbandon(null);}}><p className="modal-description">结束后不会继续写入。已经添加到 flomo 的链接会保留，请先打开两条笔记核对结果。</p><label className="note-link-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={!!busy}/>我已核对笔记，了解已写入的链接不会撤销。</label>{error && <p className="error-box" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={() => setAbandon(null)}>返回</button><button className="button primary" disabled={!!busy || !acknowledged} onClick={() => void recover(abandon,true)}>{busy ? '正在结束…' : '确认结束此次操作'}</button></div></Modal>}
  </section>;
}
