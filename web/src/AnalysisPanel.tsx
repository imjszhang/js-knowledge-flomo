import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FileText, Layers3, Loader2, Sparkles, Terminal } from "lucide-react";
import type { AnalysisKind, AnalysisRecord, AnalysisSource, Workspace } from "../../shared/contracts";
import { analysisIsStale, analysisLabels, formatAnalysisCard } from "../../shared/analysis";
import { ApiError, api, messageOf, sourceUrl } from "./api";
import { useAnalysisInput } from "./analysis-forms";
import {WritingPanel, writingLabels} from "./WritingPanel";
import Modal from "./Modal";

type RenderContent = (content: string) => ReactNode;
type Engine = AnalysisRecord["engine"];
const kinds: AnalysisKind[] = ["insights", "evolution", "connections", "outline"];
const statusLabels: Record<AnalysisRecord["status"], string> = {prepared: "等待 Codex 分析", running: "正在分析", succeeded: "分析完成", failed: "分析未完成"};
function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", {month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"});
}
function SourceSnapshot({source, renderContent}: {source: AnalysisSource; renderContent: RenderContent}) {
  const [expanded, setExpanded] = useState(false);
  return <details className="analysis-source" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary><span className="relation-chip background">{source.kind === "flomo" ? "flomo 笔记" : "收藏原文"}</span>{source.title || source.id}</summary>{expanded && <><p className="scope-notice">{source.createdAt ? `记录于 ${timestamp(source.createdAt)}` : "收藏原文快照"}{source.updatedAt ? ` · 内容更新于 ${timestamp(source.updatedAt)}` : ""}</p>{renderContent(source.content)}{sourceUrl(source.url) && <a className="text-link" href={sourceUrl(source.url)} target="_blank" rel="noopener noreferrer">查看来源<ArrowUpRight size={13}/></a>}</>}</details>;
}
function SourceList({sources, renderContent}: {sources: AnalysisSource[]; renderContent: RenderContent}) {
  const [expanded, setExpanded] = useState(false);
  return <details className="analysis-sources" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>查看本次分析的 {sources.length} 份来源快照</summary>{expanded && sources.map(source => <SourceSnapshot key={source.key} source={source} renderContent={renderContent}/>)}</details>;
}

export function AnalysisPanel({workspace, aiConfigured, disabled, flush, onUpdate, onApply, onDirty, onMaterials, onNewDraft, onOpenCard, renderContent}: {
  onMaterials: () => void;
  onNewDraft: (content:string, originAnalysisId?:string) => Promise<void>;
  onOpenCard: (analysisId:string, cardId:string) => void;
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
  const [mode, setMode] = useState<"writing" | "analysis" | "results">("writing");
  const [writingBusy, setWritingBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apply, setApply] = useState<{content:string;originAnalysisId?:string} | null>(null);
  const requestAttempt = useRef<{signature: string; version: number; key: string} | null>(null);
  const records = workspace.analyses ?? [];
  const active = records.some(record => record.status === "running" || record.cards.some(card => card.status === "publishing"));
  useEffect(() => { onDirty(!!form.question.trim() || busy || writingBusy); }, [form.question, busy, writingBusy]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void client.invalidateQueries({queryKey: ["workspace", workspace.id]}); }, 2000);
    return () => clearInterval(timer);
  }, [active, client, workspace.id]);
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
      setMode("results");
      if (!basis) setForm({...form, question: ""});
    } catch (error) {
      setError(messageOf(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) requestAttempt.current = null;
      void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
    } finally { setBusy(false); }
  }
  async function saveAsNewDraft() {
    if(!apply || busy || disabled) return;
    setBusy(true);setError('');
    try {await onNewDraft(apply.content,apply.originAnalysisId);setApply(null);}
    catch(error){setError(messageOf(error));} finally {setBusy(false);}
  }
  return <section className="analysis-panel" aria-label="写作工作区">
    <header className="writing-page-heading"><div><h2>把想法写成内容</h2><p>从一个判断出发，用材料补充，逐步写成草稿。</p></div><span className="writing-source-count">{1 + workspace.materials.length + (workspace.collectorMaterials?.length ?? 0)} 份材料</span></header>
    <nav className="analysis-navigation" aria-label="写作工具">{([['writing','展开想法'],['analysis','分析材料'],['results','结果记录']] as const).map(([value,label]) => <button key={value} aria-pressed={mode === value} className={mode === value ? 'selected' : ''} onClick={() => setMode(value)}>{label}{value === 'results' && records.length > 0 && <span>{records.length}{active ? ' · 进行中' : ''}</span>}</button>)}</nav>
    <div hidden={mode !== 'writing'}>
    <WritingPanel onPreview={(content, originAnalysisId) => setApply({content,originAnalysisId})} onBusy={setWritingBusy} workspace={workspace} aiConfigured={aiConfigured} disabled={disabled || busy} flush={flush} onUpdate={onUpdate} onMaterials={onMaterials} renderContent={renderContent}/>
    </div>
    <div hidden={mode !== 'analysis'} className="analysis-tool-surface">
    <div className="writing-step-heading"><h3>梳理已有材料</h3><p>发现主题、比较观点或寻找联系，结果保留完整来源。</p></div>
    <form className="analysis-form" onSubmit={event => { event.preventDefault(); void run(aiConfigured ? "builtin" : "external"); }}>
      <label>分析方式<select aria-label="分析方式" value={form.kind} disabled={busy} onChange={event => { setForm({...form, kind: event.target.value as AnalysisKind}); requestAttempt.current = null; }}>{kinds.map(kind => <option key={kind} value={kind}>{analysisLabels[kind]}</option>)}</select></label>
      <label>想解决的问题（可选）<textarea aria-label="分析问题" value={form.question} rows={3} maxLength={5000} readOnly={busy} onChange={event => { setForm({...form, question: event.target.value}); requestAttempt.current = null; }} placeholder="例如：我对生态位有哪些判断？哪些相互支持，哪些仍有矛盾？"/></label>
      <p className="scope-notice">本次范围：当前笔记 + {workspace.materials.length} 条 flomo 材料 + {workspace.collectorMaterials?.length ?? 0} 篇收藏原文。分析前会检查全文；材料过长时请分批选择。</p>
      <div className="analysis-actions"><button type="button" className="text-button subdued" disabled={busy} onClick={() => { setForm({...form, question: ""}); requestAttempt.current = null; }}>清空问题</button><button type="button" className="button secondary small" disabled={busy || disabled} onClick={() => void run("external")}><Terminal size={14}/>准备给 Codex</button><button type="button" className="button primary small" disabled={busy || disabled || !aiConfigured} onClick={() => void run("builtin")}>{busy ? <Loader2 size={14} className="spin"/> : <Sparkles size={14}/>}开始分析</button></div>
      <p className="agent-inline-note">{!aiConfigured && "尚未配置内置 AI，可先准备给 Codex。"}准备任务会保存材料和要求，请回到 Codex 对话让它继续当前分析；页面不会自动发起对话。</p>
    </form>
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="analysis-history" hidden={mode !== 'results'}>
      <div className="analysis-history-heading"><h3>结果记录</h3><p>展开一份结果，核对来源后用于草稿或提炼卡片。</p></div>
      {!records.length && <div className="empty-state"><FileText size={24}/><h3>还没有分析结果</h3><p>先展开一个想法，或分析已选材料。完成的内容会保存在这里。</p><button className="text-button" onClick={() => setMode('writing')}>开始展开想法</button></div>}
      {[...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((record, index) => <details key={record.id} className={`analysis-record ${record.status}`} open={index === 0}>
      <summary className="analysis-record-summary">
      <div className="analysis-record-heading"><h3>{record.writing ? writingLabels[record.writing.stage] : analysisLabels[record.kind]}</h3><span role="status">{record.status === "running" && <Loader2 size={12} className="spin"/>}{statusLabels[record.status]}</span></div>
      <p className="analysis-meta">{timestamp(record.createdAt)} · {record.engine === "builtin" ? "内置 AI" : "Codex / 外部助手"} · 使用 {record.sources.length} 份来源</p>
      </summary>
      <div className="analysis-record-body">
      {record.writing && <p className="analysis-question">{record.writing.claim}{record.writing.stage === "paragraph" ? ` · ${record.writing.section}` : ""}</p>}
      {record.question && <p className="analysis-question">{record.question}</p>}
      {analysisIsStale(record, workspace) && <p className="notice">当前目标或材料已经变化。这份分析仍使用生成时的快照，需要时可重新分析。</p>}
      {record.error && <p className="error-box" role="alert">{record.error}</p>}
      {record.status === "prepared" && <div className="agent-inline-note"><Terminal size={15}/><span>材料已准备好。可以在 Codex 中说：“继续当前工作区已准备的分析任务，并把结果保存到工作台。”</span></div>}
      {record.kind !== "cards" && record.output && <div className="analysis-output">{renderContent(record.output)}</div>}
      {record.goal && <p className="scope-notice">分析时的目标：{record.goal}</p>}
      <SourceList sources={record.sources} renderContent={renderContent}/>
      {record.status === "succeeded" && <div className="analysis-actions"><button className="text-button" disabled={disabled || busy || !record.output} onClick={() => setApply({content:record.kind === "cards" ? record.cards.map(card => formatAnalysisCard(card, record.sources)).join("\n\n---\n\n") : record.output,originAnalysisId:record.id})}><FileText size={13}/>用于草稿</button>{record.kind !== "cards" && <><button className="text-button" disabled={disabled || busy || !aiConfigured} onClick={() => void run("builtin", record)}><Layers3 size={13}/>提炼候选卡片</button><button className="text-button subdued" disabled={disabled || busy} onClick={() => void run("external", record)}>交给 Codex 提炼</button></>}</div>}
      {record.cards.length > 0 && <div className="analysis-cards"><p className="section-description">候选卡片已收进草稿，逐张核对后可创建为新笔记。</p>{record.cards.map(card => <button className="draft-result-link" key={card.id} onClick={()=>onOpenCard(record.id,card.id)}><span>{card.title}</span><span>{card.status === 'published' ? '查看已创建笔记' : '在草稿中编辑'}<ArrowUpRight size={13}/></span></button>)}</div>}
      </div>
    </details>)}</div>
    {apply && <Modal title="将结果保存到哪里" onClose={() => {if(!busy)setApply(null);}}><p className="modal-description">可以补充当前笔记，也可以独立保存为一篇新笔记草稿。</p><div className="apply-preview">{renderContent(apply.content)}</div>{error && <p className="error-box" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={disabled || busy} onClick={() => { onApply(apply.content, "append"); setApply(null); }}>追加到当前笔记</button><button className="button secondary" disabled={disabled || busy} onClick={() => { onApply(apply.content, "replace"); setApply(null); }}>替换当前笔记草稿</button><button className="button primary" disabled={disabled || busy} onClick={()=>void saveAsNewDraft()}>{busy ? '正在保存…' : '另存为新笔记草稿'}</button></div></Modal>}
  </section>;
}
