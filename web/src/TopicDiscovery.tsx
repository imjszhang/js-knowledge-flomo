import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import type { DiscoveryResult, Workspace } from "../../shared/contracts";
import { api, messageOf } from "./api";
import { splitDiscoveryTerms, useAnalysisInput } from "./analysis-forms";

const emptyForm = { terms: "", tag: "", excludeTag: "", startDate: "", endDate: "", limit: 20 };

export function TopicDiscovery({workspace, disabled, flush, onUpdate, onDirty}: {
  workspace: Workspace;
  disabled: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useAnalysisInput(`flomo:discovery:${workspace.id}`, emptyForm);
  const [baseline, setBaseline] = useAnalysisInput(`flomo:discovery-baseline:${workspace.id}`, JSON.stringify(emptyForm));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Omit<DiscoveryResult, "workspace"> | null>(null);
  const dirty = JSON.stringify(form) !== baseline;
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy]);
  const terms = splitDiscoveryTerms(form.terms);
  const invalidRange = !!form.startDate && !!form.endDate && form.startDate > form.endDate;
  async function discover() {
    if (busy || disabled || !terms.length || terms.length > 6 || invalidRange) return;
    setBusy(true); setError("");
    try {
      const saved = await flush();
      const found = await api.discover(workspace.id, {
        terms, limit: form.limit, baseVersion: saved.version,
        ...(form.tag.trim() ? {tag: form.tag.trim().replace(/^#+/, "")} : {}),
        ...(form.excludeTag.trim() ? {excludeTag: form.excludeTag.trim().replace(/^#+/, "")} : {}),
        ...(form.startDate ? {startDate: form.startDate} : {}),
        ...(form.endDate ? {endDate: form.endDate} : {}),
      });
      onUpdate(found.workspace);
      const {workspace: _workspace, ...summary} = found;
      setResult(summary); setBaseline(JSON.stringify(form));
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
    } finally { setBusy(false); }
  }
  const field = (name: keyof typeof emptyForm, value: string | number) => setForm({...form, [name]: value});
  return <details className="quiet-disclosure topic-discovery">
    <summary><Search size={15}/>按主题找材料</summary>
    <p className="section-description">分别搜索几个相关概念，去重并补读全文后加入待选材料，由你决定采用哪些。</p>
    <form className="analysis-form" onSubmit={(event) => { event.preventDefault(); void discover(); }}>
      <label>相关概念<textarea aria-label="主题搜索关键词" rows={3} value={form.terms} readOnly={busy} placeholder={"生态位\n差异化\n竞争, 协作"} onChange={(event) => field("terms", event.target.value)}/><small>最多 6 项，用换行或逗号分隔。每一项会单独检索；项内空格保留为组合检索。</small></label>
      <details className="quiet-disclosure"><summary>限定标签与日期</summary><div className="analysis-filter-grid">
        <label>包含标签<input aria-label="主题搜索包含标签" value={form.tag} maxLength={200} readOnly={busy} onChange={(event) => field("tag", event.target.value)} placeholder="例如：想法"/></label>
        <label>排除标签<input aria-label="主题搜索排除标签" value={form.excludeTag} maxLength={200} readOnly={busy} onChange={(event) => field("excludeTag", event.target.value)} placeholder="例如：概要"/></label>
        <label>开始日期<input aria-label="主题搜索开始日期" type="date" value={form.startDate} readOnly={busy} onChange={(event) => field("startDate", event.target.value)}/></label>
        <label>结束日期<input aria-label="主题搜索结束日期" type="date" value={form.endDate} readOnly={busy} onChange={(event) => field("endDate", event.target.value)}/></label>
      </div></details>
      <label className="analysis-limit">最多补读<select aria-label="主题搜索补读上限" value={form.limit} disabled={busy} onChange={(event) => field("limit", Number(event.target.value))}>{[10,20,30].map(limit => <option key={limit} value={limit}>{limit} 条笔记</option>)}</select></label>
      {terms.length > 6 && <p className="notice">最多搜索 6 个概念，请分成几次查找。</p>}
      {invalidRange && <p className="notice">结束日期不能早于开始日期。</p>}
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="inline-actions"><button type="button" className="text-button subdued" disabled={busy} onClick={() => { setForm(emptyForm); setBaseline(JSON.stringify(emptyForm)); setError(""); }}>清空条件</button><button className="button secondary small" disabled={disabled || busy || !terms.length || terms.length > 6 || invalidRange}>{busy ? <Loader2 size={14} className="spin"/> : <Search size={14}/>}查找主题材料</button></div>
    </form>
    {result && <div className="discovery-result" role="status"><p>已检索 {result.terms.join("、")}，读取 {result.readCount} 条全文。候选已合并到下方“待你选择”，已有选择保留。</p>{result.possiblyLimited && <p className="scope-notice">搜索结果或补读数量达到上限，本次不代表全部相关笔记。可以缩小日期范围继续查找。</p>}{result.omitted.length > 0 && <details><summary>{result.omitted.length} 条未加入本次候选</summary><ul>{result.omitted.map((item, i) => <li key={`${item.memoId}:${i}`}>{item.memoId}：{item.reason}</li>)}</ul></details>}</div>}
  </details>;
}
