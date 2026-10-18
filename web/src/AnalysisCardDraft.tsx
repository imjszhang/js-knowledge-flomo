import {useEffect, useState, type ReactNode} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {ArrowUpRight, Check, Loader2} from 'lucide-react';
import type {AnalysisCard, AnalysisCardInput, AnalysisRecord, Workspace} from '../../shared/contracts';
import {formatAnalysisCard} from '../../shared/analysis';
import {api, messageOf, sourceUrl} from './api';
import {useAnalysisInput} from './analysis-forms';
import Modal from './Modal';
type RenderContent = (content:string)=>ReactNode;
const cardStatusLabels: Record<AnalysisCard["status"], string> = {draft: "候选卡片", publishing: "正在创建笔记", published: "已创建笔记", uncertain: "创建结果待核对", failed: "创建未完成"};
function cardInput(card: AnalysisCardInput): AnalysisCardInput {
  return {title: card.title, body: card.body, tags: card.tags, sourceKeys: card.sourceKeys};
}
function inputSignature(card: AnalysisCardInput) { return JSON.stringify(cardInput(card)); }

export function AnalysisCardDraft(props: {
  workspace:Workspace; record:AnalysisRecord; card:AnalysisCard; disabled:boolean;
  flush:()=>Promise<Workspace>; onUpdate:(workspace:Workspace)=>void; onDirty:(dirty:boolean)=>void; renderContent:RenderContent;
}) {
  const {workspace,record,card,disabled,flush,onUpdate,onDirty,renderContent} = props;
  const client = useQueryClient();
  const [busy,setBusy] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [error,setError] = useState('');
  const [preview,setPreview] = useState<{content:string;version:number;key:string}|null>(null);
  useEffect(()=>{onDirty(dirty || busy);},[dirty,busy]);
  async function prepare() {
    setBusy(true);setError('');
    try {
      const saved = await flush();
      const latestRecord = saved.analyses?.find(item=>item.id === record.id);
      const latest = latestRecord?.cards.find(item=>item.id === card.id);
      if(!latest || !latestRecord || !latest.reviewedAt || inputSignature(latest) !== inputSignature(card) || latest.status !== 'draft') throw new Error('卡片已经更新，请先核对并保存最新内容。');
      setPreview({content:formatAnalysisCard(latest,latestRecord.sources),version:saved.version,key:crypto.randomUUID()});
    } catch(error) {setError(messageOf(error));} finally {setBusy(false);}
  }
  async function publish() {
    if(!preview || busy || disabled) return;
    setBusy(true);setError('');
    try {onUpdate(await api.publishAnalysisCard(workspace.id,record.id,card.id,preview.version,preview.key));setPreview(null);}
    catch(error){setError(messageOf(error));void client.invalidateQueries({queryKey:['workspace',workspace.id]});}
    finally{setBusy(false);}
  }
  return <section className="note-draft-editor">
    <p className="scope-notice">由材料分析提炼的独立卡片。确认后将创建为一条新笔记。</p>
    <AnalysisCardEditor {...props} disabled={disabled || busy} onDirty={setDirty} onPreview={prepare}/>
    {card.status === 'published' && <div className="draft-preview">{renderContent(formatAnalysisCard(card,record.sources))}</div>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {preview && <Modal title="确认创建 flomo 卡片" onClose={()=>{if(!busy)setPreview(null);}}><p className="modal-description">以下内容将创建为一条新笔记，包含已确认的标签和来源。</p><div className="apply-preview">{renderContent(preview.content)}</div>{workspace.version !== preview.version && <p className="notice">工作区已更新，请关闭后重新预览。</p>}{error && <p className="error-box" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setPreview(null)}>返回核对</button><button className="button primary" disabled={busy || disabled || workspace.version !== preview.version} onClick={()=>void publish()}>确认创建新笔记</button></div></Modal>}
  </section>;
}

function AnalysisCardEditor({workspace, record, card, disabled, flush, onUpdate, onDirty, onPreview, renderContent}: {
  workspace: Workspace;
  record: AnalysisRecord;
  card: AnalysisCard;
  disabled: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onDirty: (dirty: boolean) => void;
  onPreview: () => Promise<void>;
  renderContent: RenderContent;
}) {
  const client = useQueryClient();
  const initial = cardInput(card);
  const [editing, setEditing] = useAnalysisInput(`flomo:analysis-card:${workspace.id}:${record.id}:${card.id}`, {baseline: initial, input: initial, tagText: initial.tags.join(" ")});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = editing.input;
  const dirty = inputSignature(input) !== inputSignature(editing.baseline) || editing.tagText !== editing.baseline.tags.join(" ");
  const remoteChanged = inputSignature(editing.baseline) !== inputSignature(card);
  const locked = ["publishing", "published", "uncertain"].includes(card.status);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy]);
  useEffect(() => {
    if (!dirty && !busy && remoteChanged) {
      const latest = cardInput(card); setEditing({baseline: latest, input: latest, tagText: latest.tags.join(" ")});
    }
  }, [dirty, busy, remoteChanged, card]);
  function change(next: Partial<AnalysisCardInput>) { setEditing({...editing, input: {...input, ...next}}); }
  function reset() {
    const latest = cardInput(card); setEditing({baseline: latest, input: latest, tagText: latest.tags.join(" ")}); setError("");
  }
  async function save() {
    if (busy || disabled || locked || (dirty && remoteChanged)) return;
    setBusy(true); setError("");
    try {
      const saved = await flush();
      const latest = saved.analyses?.find(item => item.id === record.id)?.cards.find(item => item.id === card.id);
      if (!latest || inputSignature(latest) !== inputSignature(editing.baseline)) throw new Error("另一端已修改这张卡片，你的输入已保留。请核对新内容后再保存。");
      const updated = await api.saveAnalysisCard(workspace.id, record.id, card.id, {...input, baseVersion: saved.version});
      onUpdate(updated);
      const confirmed = updated.analyses?.find(item => item.id === record.id)?.cards.find(item => item.id === card.id);
      if (confirmed) { const next = cardInput(confirmed); setEditing({baseline: next, input: next, tagText: next.tags.join(" ")}); }
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
    } finally { setBusy(false); }
  }
  const invalid = !input.title.trim() || !input.body.trim() || !input.sourceKeys.length || input.tags.length > 10 || input.tags.some(tag => !/^[^\s#<>]+$/.test(tag));
  return <section className={`analysis-card ${card.status}`}>
    <div className="analysis-record-heading"><h4>{card.title}</h4><span>{cardStatusLabels[card.status]}</span></div>
    {card.status === "published" && card.resultMemo ? <><p className="selected-label"><Check size={13}/>已创建，原笔记与草稿保持原样。</p>{sourceUrl(card.resultMemo.url) && <a className="text-link" href={sourceUrl(card.resultMemo.url)} target="_blank" rel="noopener noreferrer">查看新笔记<ArrowUpRight size={13}/></a>}{dirty && <><p className="notice">笔记创建后，本地还有未提交的编辑。请先核对新笔记，再清除这些输入。</p><button className="text-button subdued" onClick={reset}>清除未提交的本地编辑</button></>}</> : <>
      {locked && <p className="scope-notice">{card.status === "publishing" ? "正在等待 flomo 返回创建结果，请勿重复提交。" : "创建请求可能已到达 flomo。请先在 flomo 核对，工作台已停止重复创建。"}</p>}
      <div className="analysis-form">
        <label>卡片标题<input aria-label={`卡片标题：${card.id}`} value={input.title} maxLength={200} readOnly={busy || locked} onChange={event => change({title: event.target.value})}/></label>
        <label>独立判断与依据<textarea aria-label={`卡片正文：${card.id}`} value={input.body} maxLength={15000} rows={5} readOnly={busy || locked} onChange={event => change({body: event.target.value})}/></label>
        <label>标签<input aria-label={`卡片标签：${card.id}`} value={editing.tagText} readOnly={busy || locked} onChange={event => { const value = event.target.value; setEditing({...editing, tagText: value, input: {...input, tags: [...new Set(value.split(/[\s,，]+/).map(tag => tag.replace(/^#+/, "")).filter(Boolean))]}}); }}/><small>空格或逗号分隔，最多 10 个。例如：想法 生态位 待编</small></label>
        <fieldset className="analysis-source-choices" disabled={busy || locked}><legend>关联来源（原有出处保留，可添加来源）</legend>{record.sources.map(source => <label key={source.key}><input type="checkbox" disabled={card.sourceKeys.includes(source.key)} checked={input.sourceKeys.includes(source.key)} onChange={event => change({sourceKeys: event.target.checked ? [...input.sourceKeys, source.key] : input.sourceKeys.filter(key => key !== source.key)})}/><span>{source.kind === "collector" ? "收藏原文 · " : "笔记 · "}{source.title || source.id}</span></label>)}</fieldset>
      </div>
      {dirty && remoteChanged && <div className="notice"><p>另一端修改了这张卡片，你的编辑已保留。以下是另一端最新内容：</p><div className="apply-preview">{renderContent(formatAnalysisCard(card, record.sources))}</div><div className="inline-actions"><button className="text-button" onClick={reset}>采用另一端内容</button>{!locked && <button className="text-button" onClick={() => setEditing({...editing, baseline: cardInput(card)})}>已核对，继续编辑我的版本</button>}</div></div>}
      {error && <p className="error-box" role="alert">{error}</p>}{card.error && <p className="error-box" role="alert">{card.error}</p>}
      {!locked && <div className="analysis-actions">{dirty && <button className="text-button subdued" disabled={busy} onClick={reset}>放弃本次编辑</button>}<button className="button secondary small" disabled={disabled || busy || invalid || (dirty && remoteChanged)} onClick={() => void save()}>{busy ? "正在保存…" : "保存并确认卡片"}</button><button className="button primary small" disabled={disabled || busy || dirty || remoteChanged || !card.reviewedAt} onClick={() => void onPreview()}>预览创建笔记</button></div>}
      {!locked && card.reviewedAt && !dirty && <p className="scope-notice">已保存并核对，可预览完整内容后创建。</p>}
      {locked && dirty && <button className="text-button subdued" disabled={busy} onClick={reset}>清除未提交的本地编辑</button>}
    </>}
  </section>;
}
