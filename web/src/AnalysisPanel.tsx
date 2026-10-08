import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, FileText, Layers3, Loader2, Sparkles, Terminal } from "lucide-react";
import type { AnalysisCard, AnalysisCardInput, AnalysisKind, AnalysisRecord, AnalysisSource, Workspace } from "../../shared/contracts";
import { analysisIsStale, analysisLabels, formatAnalysisCard } from "../../shared/analysis";
import { ApiError, api, messageOf, sourceUrl } from "./api";
import { useAnalysisInput } from "./analysis-forms";
import {WritingPanel, writingLabels} from "./WritingPanel";
import Modal from "./Modal";

type RenderContent = (content: string) => ReactNode;
type Engine = AnalysisRecord["engine"];
const kinds: AnalysisKind[] = ["insights", "evolution", "connections", "outline"];
const statusLabels: Record<AnalysisRecord["status"], string> = {prepared: "等待 Codex 分析", running: "正在分析", succeeded: "分析完成", failed: "分析未完成"};
const cardStatusLabels: Record<AnalysisCard["status"], string> = {draft: "候选卡片", publishing: "正在创建笔记", published: "已创建笔记", uncertain: "创建结果待核对", failed: "创建未完成"};
function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
}
function cardInput(card: AnalysisCardInput): AnalysisCardInput {
  return {title: card.title, body: card.body, tags: card.tags, sourceKeys: card.sourceKeys};
}
function inputSignature(card: AnalysisCardInput) { return JSON.stringify(cardInput(card)); }
function SourceSnapshot({source, renderContent}: {source: AnalysisSource; renderContent: RenderContent}) {
  const [expanded, setExpanded] = useState(false);
  return <details className="analysis-source" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><span className="relation-chip background">{source.kind === "flomo" ? "flomo 笔记" : "收藏原文"}</span>{source.title || source.id}</summary>{expanded && <><p className="scope-notice">{source.createdAt ? `记录于 ${timestamp(source.createdAt)}` : "收藏原文快照"}{source.updatedAt ? ` · 内容更新于 ${timestamp(source.updatedAt)}` : ""}</p>{renderContent(source.content)}{sourceUrl(source.url) && <a className="text-link" href={sourceUrl(source.url)} target="_blank" rel="noopener noreferrer">查看来源<ArrowUpRight size={13}/></a>}</>}</details>;
}
function SourceList({sources, renderContent}: {sources: AnalysisSource[]; renderContent: RenderContent}) {
  const [expanded, setExpanded] = useState(false);
  return <details className="analysis-sources" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>查看本次分析的 {sources.length} 份来源快照</summary>{expanded && sources.map(source => <SourceSnapshot key={source.key} source={source} renderContent={renderContent}/>)}</details>;
}

export function AnalysisPanel({workspace, aiConfigured, disabled, flush, onUpdate, onApply, onDirty, onMaterials, renderContent}: {
  onMaterials: () => void;
  workspace: Workspace;
  aiConfigured: boolean;
  disabled: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onApply: (content: string, mode: "append" | "replace") => void;
  onDirty: (dirty: boolean) => void;
  renderContent: RenderContent;
}) {
  const client = useQueryClient();
  const [form, setForm] = useAnalysisInput<{kind: AnalysisKind; question: string}>(`flomo:analysis:${workspace.id}`, {kind: "insights", question: ""});
  const [writingBusy, setWritingBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apply, setApply] = useState<string | null>(null);
  const [dirtyCards, setDirtyCards] = useState(new Set<string>());
  const [publishPreview, setPublishPreview] = useState<{analysisId: string; cardId: string; content: string; version: number; key: string} | null>(null);
  const requestAttempt = useRef<{signature: string; version: number; key: string} | null>(null);
  const records = workspace.analyses ?? [];
  const active = records.some(record => record.status === "running" || record.cards.some(card => card.status === "publishing"));
  useEffect(() => { onDirty(!!form.question.trim() || busy || writingBusy || dirtyCards.size > 0); }, [form.question, busy, writingBusy, dirtyCards]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void client.invalidateQueries({queryKey: ["workspace", workspace.id]}); }, 2000);
    return () => clearInterval(timer);
  }, [active, client, workspace.id]);
  function trackCard(id: string, dirty: boolean) {
    setDirtyCards(previous => {
      if (previous.has(id) === dirty) return previous;
      const next = new Set(previous); if (dirty) next.add(id); else next.delete(id); return next;
    });
  }
  async function run(engine: Engine, basis?: AnalysisRecord) {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      const saved = await flush();
      const input = {kind: basis ? "cards" as const : form.kind, question: basis ? basis.question : form.question.trim(), engine, ...(basis ? {basisAnalysisId: basis.id} : {})};
      const signature = JSON.stringify(input);
      if (!requestAttempt.current || requestAttempt.current.signature !== signature) requestAttempt.current = {signature, version: saved.version, key: crypto.randomUUID()};
      const attempt = requestAttempt.current;
      onUpdate(await api.createAnalysis(workspace.id, {...input, baseVersion: attempt.version, idempotencyKey: attempt.key}));
      requestAttempt.current = null;
      if (!basis) setForm({...form, question: ""});
    } catch (error) {
      setError(messageOf(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) requestAttempt.current = null;
      void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
    } finally { setBusy(false); }
  }
  async function previewCard(record: AnalysisRecord, card: AnalysisCard) {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      const saved = await flush();
      const latestRecord = saved.analyses?.find(item => item.id === record.id);
      const latest = latestRecord?.cards.find(item => item.id === card.id);
      if (!latest || !latestRecord || !latest.reviewedAt || inputSignature(latest) !== inputSignature(card) || !["draft", "failed"].includes(latest.status)) throw new Error("卡片已经更新，请先核对并保存最新内容后预览。");
      setPublishPreview({analysisId: record.id, cardId: card.id, content: formatAnalysisCard(latest, latestRecord.sources), version: saved.version, key: crypto.randomUUID()});
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!publishPreview || busy || disabled) return;
    setBusy(true); setError("");
    try {
      onUpdate(await api.publishAnalysisCard(workspace.id, publishPreview.analysisId, publishPreview.cardId, publishPreview.version, publishPreview.key));
      setPublishPreview(null);
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
    } finally { setBusy(false); }
  }
  return <details className="quiet-disclosure analysis-panel">
    <summary><Sparkles size={15}/>分析材料与写卡片<span>{records.length || ""}</span></summary>
    <p className="section-description">把当前笔记、已选 flomo 材料和收藏原文串联起来。每次分析保留来源快照，方便核对判断的依据。</p>
    <WritingPanel onBusy={setWritingBusy} workspace={workspace} aiConfigured={aiConfigured} disabled={disabled || busy} flush={flush} onUpdate={onUpdate} onMaterials={onMaterials} renderContent={renderContent}/>
    <form className="analysis-form" onSubmit={event => { event.preventDefault(); void run(aiConfigured ? "builtin" : "external"); }}>
      <label>分析方式<select aria-label="分析方式" value={form.kind} disabled={busy} onChange={event => { setForm({...form, kind: event.target.value as AnalysisKind}); requestAttempt.current = null; }}>{kinds.map(kind => <option key={kind} value={kind}>{analysisLabels[kind]}</option>)}</select></label>
      <label>想解决的问题（可选）<textarea aria-label="分析问题" value={form.question} rows={3} maxLength={5000} readOnly={busy} onChange={event => { setForm({...form, question: event.target.value}); requestAttempt.current = null; }} placeholder="例如：我对生态位有哪些判断？哪些相互支持，哪些仍有矛盾？"/></label>
      <p className="scope-notice">本次范围：当前笔记 + {workspace.materials.length} 条 flomo 材料 + {workspace.collectorMaterials?.length ?? 0} 篇收藏原文。分析前会检查全文；材料过长时请分批选择。</p>
      <div className="analysis-actions"><button type="button" className="text-button subdued" disabled={busy} onClick={() => { setForm({...form, question: ""}); requestAttempt.current = null; }}>清空问题</button><button type="button" className="button secondary small" disabled={busy || disabled} onClick={() => void run("external")}><Terminal size={14}/>准备给 Codex</button><button type="button" className="button primary small" disabled={busy || disabled || !aiConfigured} onClick={() => void run("builtin")}>{busy ? <Loader2 size={14} className="spin"/> : <Sparkles size={14}/>}开始分析</button></div>
      <p className="agent-inline-note">{!aiConfigured && "尚未配置内置 AI，可先准备给 Codex。"}准备任务会保存材料和要求，请回到 Codex 对话让它继续当前分析；页面不会自动发起对话。</p>
    </form>
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="analysis-history">{[...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => <article key={record.id} className={`analysis-record ${record.status}`}>
      <div className="analysis-record-heading"><h3>{record.writing ? writingLabels[record.writing.stage] : analysisLabels[record.kind]}</h3><span role="status">{record.status === "running" && <Loader2 size={12} className="spin"/>}{statusLabels[record.status]}</span></div>
      <p className="analysis-meta">{timestamp(record.createdAt)} · {record.engine === "builtin" ? "内置 AI" : "Codex / 外部助手"} · 使用 {record.sources.length} 份来源</p>
      {record.writing && <p className="analysis-question">{record.writing.claim}{record.writing.stage === "paragraph" ? ` · ${record.writing.section}` : ""}</p>}
      {record.question && <p className="analysis-question">{record.question}</p>}
      {analysisIsStale(record, workspace) && <p className="notice">当前目标或材料已经变化。这份分析仍使用生成时的快照，需要时可重新分析。</p>}
      {record.error && <p className="error-box" role="alert">{record.error}</p>}
      {record.status === "prepared" && <div className="agent-inline-note"><Terminal size={15}/><span>材料已准备好。可以在 Codex 中说：“继续当前工作区已准备的分析任务，并把结果保存到工作台。”</span></div>}
      {record.kind !== "cards" && record.output && <div className="analysis-output">{renderContent(record.output)}</div>}
      {record.goal && <p className="scope-notice">分析时的目标：{record.goal}</p>}
      <SourceList sources={record.sources} renderContent={renderContent}/>
      {record.status === "succeeded" && <div className="analysis-actions"><button className="text-button" disabled={disabled || busy || !record.output} onClick={() => setApply(record.kind === "cards" ? record.cards.map(card => formatAnalysisCard(card, record.sources)).join("\n\n---\n\n") : record.output)}><FileText size={13}/>用于草稿</button>{record.kind !== "cards" && <><button className="text-button" disabled={disabled || busy || !aiConfigured} onClick={() => void run("builtin", record)}><Layers3 size={13}/>提炼候选卡片</button><button className="text-button subdued" disabled={disabled || busy} onClick={() => void run("external", record)}>交给 Codex 提炼</button></>}</div>}
      {record.cards.length > 0 && <div className="analysis-cards"><p className="section-description">逐张核对独立判断、标签和来源，保存后预览，再确认创建为新的 flomo 笔记。</p>{record.cards.map(card => <AnalysisCardEditor key={card.id} workspace={workspace} record={record} card={card} disabled={busy || disabled} flush={flush} onUpdate={onUpdate} onDirty={dirty => trackCard(`${record.id}:${card.id}`, dirty)} onPreview={() => previewCard(record, card)} renderContent={renderContent}/>)}</div>}
    </article>)}</div>
    {apply && <Modal title="将分析结果用于草稿" onClose={() => setApply(null)}><p className="modal-description">先核对下面的分析，再选择追加或替换。更改会自动保存到工作台，确认写回后才会更新 flomo。</p><div className="apply-preview">{renderContent(apply)}</div><div className="modal-actions"><button className="button secondary" disabled={disabled} onClick={() => { onApply(apply, "append"); setApply(null); }}>追加到草稿</button><button className="button primary" disabled={disabled} onClick={() => { onApply(apply, "replace"); setApply(null); }}>替换当前草稿</button></div></Modal>}
    {publishPreview && <Modal title="确认创建 flomo 卡片" onClose={() => { if (!busy) setPublishPreview(null); }}><p className="modal-description">以下完整内容将创建为一条新笔记，包含你确认的标签和来源链接。</p><div className="apply-preview">{renderContent(publishPreview.content)}</div>{workspace.version !== publishPreview.version && <p className="notice">工作区已更新，请关闭后重新预览最新内容。</p>}{error && <p className="error-box" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setPublishPreview(null)}>返回核对</button><button className="button primary" disabled={busy || disabled || workspace.version !== publishPreview.version} onClick={() => void publish()}>{busy ? <Loader2 size={14} className="spin"/> : <ArrowUpRight size={14}/>}确认创建新笔记</button></div></Modal>}
  </details>;
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
