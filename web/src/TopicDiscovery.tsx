import { randomUUID } from "./browser-compat";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, Sparkles } from "lucide-react";
import type { DiscoveryResult, Job, Workspace } from "../../shared/contracts";
import { ApiError, api, messageOf } from "./api";
import { splitDiscoveryTerms, useAnalysisInput } from "./analysis-forms";
import { discoveryFilterInput, discoveryJobLabel, emptyDiscoveryFilters as emptyFilters, mergeDiscoveryJob, prepareDiscoveryAttempt, type DiscoveryAttempt } from "./discovery-jobs";

const emptyForm = { terms: "", ...emptyFilters };
type DiscoveryMode = "ai" | "manual";
type DiscoverySummary = Omit<DiscoveryResult, "workspace">;
const actorLabels: Record<Job["actor"], string> = {web:"网页",cli:"CLI",mcp:"MCP"};

function readBaseline(value: string): typeof emptyForm {
  try { return {...emptyForm, ...JSON.parse(value)}; }
  catch { return emptyForm; }
}

function DiscoverySummaryView({result}: {result: DiscoverySummary}) {
  return <div className="discovery-result">
    {result.ai && <p>{result.ai.summary}</p>}
    <p>检索词：{result.terms.join("、") || "未生成检索词"}</p>
    {(result.ai?.recommendedCount === 0 || result.readCount === 0) && <p>本次没有推荐材料，可以调整方向或搜索范围后再试。</p>}
    {result.possiblyLimited && <p className="scope-notice">搜索结果或补读数量达到上限，本次不代表全部相关笔记。可以缩小日期范围继续查找。</p>}
    {result.omitted.length > 0 && <details><summary>{result.omitted.length} 条未加入本次候选</summary><ul>{result.omitted.map((item, i) => <li key={`${item.memoId}:${i}`}>{item.memoId}：{item.reason}</li>)}</ul></details>}
  </div>;
}

function jobDate(job: Job) {
  const parsed = new Date(job.createdAt);
  return Number.isNaN(parsed.getTime()) ? job.createdAt : parsed.toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
}

function DiscoveryJobView({job}: {job: Job}) {
  const input = job.discovery?.input;
  const result = job.discovery?.result;
  const terms = job.discovery?.terms;
  const scope = input && [input.tag && `包含 #${input.tag}`,input.excludeTag && `排除 #${input.excludeTag}`,input.startDate && `从 ${input.startDate}`,input.endDate && `至 ${input.endDate}`,`最多补读 ${input.limit} 条`].filter(Boolean).join(" · ");
  const details = <div className="discovery-job-details">
    <p className="discovery-job-direction">查找方向：{input?.instruction || "根据当前笔记和目标自动寻找"}</p>
    {scope && <p className="scope-notice">{scope}</p>}
    <p className="discovery-job-meta">由{actorLabels[job.actor] ?? job.actor}发起</p>
    {result ? <DiscoverySummaryView result={result}/> : <>{!!terms?.length && <p className="discovery-job-terms">检索词：{terms.join("、")}</p>}{job.text && <p className="discovery-job-summary">{job.text}</p>}</>}
  </div>;
  if (job.status === "succeeded" && result) return <article className="discovery-job succeeded">
    <details className="discovery-job-disclosure">
      <summary className="discovery-job-toggle"><span className="discovery-job-overview"><strong>{result.ai ? `推荐 ${result.ai.recommendedCount} 条` : "查找完成"}</strong><span> · 已读 {result.readCount} 条</span></span><span className="discovery-job-meta">{jobDate(job)} · 详情</span></summary>
      {details}
    </details>
  </article>;
  return <article className={`discovery-job ${job.status}`}>
    <div className="discovery-job-heading"><strong>{job.status === "running" && <Loader2 size={13} className="spin"/>}{discoveryJobLabel(job)}</strong><span>{actorLabels[job.actor] ?? job.actor}发起 · {jobDate(job)}</span></div>
    {job.status === "running" && <p className="scope-notice">正在后台查找，结果会自动更新。</p>}
    {job.error && <p className="error-box" role="alert">{job.error}</p>}
    <details className="discovery-job-disclosure"><summary>查找详情</summary>{details}</details>
  </article>;
}

export function TopicDiscovery({workspace, jobs, aiConfigured, disabled, flush, onUpdate, onDirty, onStatus}: {
  workspace: Workspace;
  jobs: Job[];
  aiConfigured: boolean;
  disabled: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onDirty: (dirty: boolean) => void;
  onStatus?: (message: string) => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useAnalysisInput(`flomo:discovery:${workspace.id}`, emptyForm);
  const [baseline, setBaseline] = useAnalysisInput(`flomo:discovery-baseline:${workspace.id}`, JSON.stringify(emptyForm));
  const [instruction, setInstruction] = useAnalysisInput(`flomo:discovery-ai:${workspace.id}`, "");
  const [instructionBaseline, setInstructionBaseline] = useAnalysisInput(`flomo:discovery-ai-baseline:${workspace.id}`, "");
  const [unconfirmed, setUnconfirmed] = useAnalysisInput<DiscoveryAttempt | null>(`flomo:discovery-ai-attempt:${workspace.id}`, null);
  const attemptRef = useRef(unconfirmed);
  const submissionController = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState<DiscoveryMode | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DiscoverySummary | null>(null);
  const [historyCount, setHistoryCount] = useState(5);
  const discoveryJobs = jobs.filter(job => job.kind === "discovery").sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const running = discoveryJobs.some(job => job.status === "running");
  const dirty = JSON.stringify(form) !== baseline || instruction !== instructionBaseline;
  useEffect(() => { onDirty(dirty || !!busy || !!unconfirmed); }, [dirty, busy, unconfirmed]);
  useEffect(() => {
    onStatus?.(error ? "查找遇到问题，展开查看" : unconfirmed && !busy ? "上次提交待确认" : busy === "ai" ? "正在提交任务…" : busy === "manual" ? "正在查找…" : "");
  }, [error, unconfirmed, busy, onStatus]);
  const terms = splitDiscoveryTerms(form.terms);
  const invalidRange = !!form.startDate && !!form.endDate && form.startDate > form.endDate;
  const filtersActive = !!(form.tag || form.excludeTag || form.startDate || form.endDate);
  const field = (name: keyof typeof emptyForm, value: string | number) => setForm({...form, [name]: value});
  const acknowledgeFields = (fields: Partial<typeof emptyForm>) => setBaseline(JSON.stringify({...readBaseline(baseline), ...fields}));

  function rememberAttempt(attempt: DiscoveryAttempt | null) {
    attemptRef.current = attempt;
    setUnconfirmed(attempt);
    // Persist before sending: a reload after a lost response must reuse the same request.
    try {
      const key = `flomo:discovery-ai-attempt:${workspace.id}`;
      if (attempt) localStorage.setItem(key,JSON.stringify(attempt));
      else localStorage.removeItem(key);
    } catch { /* In-memory retry and navigation protection still apply. */ }
  }
  function confirmAttempt(attempt: DiscoveryAttempt) {
    if (attemptRef.current?.payload.idempotencyKey !== attempt.payload.idempotencyKey) return;
    acknowledgeFields(attempt.filters);
    setInstructionBaseline(attempt.instruction);
    rememberAttempt(null);
    setError("");
    // A durable job in the feed is enough to confirm submission; stop waiting on a lost response.
    submissionController.current?.abort();
  }
  useEffect(() => {
    const attempt = attemptRef.current;
    if (attempt && discoveryJobs.some(job => job.idempotencyKey === attempt.payload.idempotencyKey)) confirmAttempt(attempt);
  }, [jobs]);

  async function startAI() {
    if (pending.current || disabled || running) return;
    if (!attemptRef.current && (!aiConfigured || invalidRange)) return;
    pending.current = true; setBusy("ai"); setError("");
    let attempt: DiscoveryAttempt | null = null;
    try {
      if (!attemptRef.current) {
        const saved = await flush();
        rememberAttempt(prepareDiscoveryAttempt(null,form,instruction,saved.version,() => randomUUID()));
      }
      attempt = attemptRef.current!;
      submissionController.current = new AbortController();
      const job = await api.startAIDiscovery(workspace.id,attempt.payload,submissionController.current.signal);
      client.setQueryData<Job[]>(["jobs",workspace.id],previous => mergeDiscoveryJob(previous,job));
      confirmAttempt(attempt);
      void client.invalidateQueries({queryKey:["jobs",workspace.id]});
    } catch (error) {
      // The jobs feed can confirm an accepted task even when its start response is lost.
      if (attempt && attemptRef.current?.payload.idempotencyKey !== attempt.payload.idempotencyKey) return;
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      if (rejected) rememberAttempt(null);
      setError(`${messageOf(error)}${attempt && !rejected ? " 未能确认任务是否已创建。重试确认会核对上次提交，不重复创建任务。" : ""}`);
      void client.invalidateQueries({queryKey:["jobs",workspace.id]});
      void client.invalidateQueries({queryKey:["workspace",workspace.id]});
    } finally { submissionController.current = null; pending.current = false; setBusy(null); }
  }

  async function discoverManually() {
    if (pending.current || disabled || running || attemptRef.current || invalidRange || !terms.length || terms.length > 6) return;
    pending.current = true; setBusy("manual"); setError(""); setResult(null);
    try {
      const saved = await flush();
      const found = await api.discover(workspace.id,{...discoveryFilterInput(form),terms,baseVersion:saved.version});
      onUpdate(found.workspace);
      const {workspace:_workspace,...summary} = found;
      setResult(summary); setBaseline(JSON.stringify(form));
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({queryKey:["workspace",workspace.id]});
    } finally { pending.current = false; setBusy(null); }
  }

  return <section className="topic-discovery" aria-label="找材料" aria-busy={!!busy}>
    <div className="ai-discovery">
      <div className="ai-discovery-heading"><h3><Sparkles size={17}/>AI 找材料</h3><p className="section-description">从你的笔记中找关联，读完全文后推荐。</p></div>
      <div className="analysis-form">
        <label>查找方向（可选）<textarea aria-label="AI 找材料方向" rows={2} value={instruction} maxLength={2000} readOnly={!!busy} placeholder="留空按当前笔记查找，或指定：找反例、实际案例…" onChange={(event) => setInstruction(event.target.value)}/></label>
        <div className="discovery-options-row">
        <details className="quiet-disclosure discovery-filters"><summary>搜索范围<span>{filtersActive ? "已筛选 · " : ""}最多 {form.limit} 条</span></summary>
          <p className="scope-notice">同样适用于手动查找。</p>
          <div className="analysis-filter-grid">
            <label>包含标签<input aria-label="主题搜索包含标签" value={form.tag} maxLength={200} readOnly={!!busy} onChange={(event) => field("tag", event.target.value)} placeholder="例如：想法"/></label>
            <label>排除标签<input aria-label="主题搜索排除标签" value={form.excludeTag} maxLength={200} readOnly={!!busy} onChange={(event) => field("excludeTag", event.target.value)} placeholder="例如：概要"/></label>
            <label>开始日期<input aria-label="主题搜索开始日期" type="date" value={form.startDate} readOnly={!!busy} onChange={(event) => field("startDate", event.target.value)}/></label>
            <label>结束日期<input aria-label="主题搜索结束日期" type="date" value={form.endDate} readOnly={!!busy} onChange={(event) => field("endDate", event.target.value)}/></label>
          </div>
          <div className="discovery-filter-actions"><label className="analysis-limit">最多补读<select aria-label="主题搜索补读上限" value={form.limit} disabled={!!busy} onChange={(event) => field("limit", Number(event.target.value))}>{[10,20,30].map(limit => <option key={limit} value={limit}>{limit} 条笔记</option>)}</select></label><button type="button" className="text-button subdued" disabled={!!busy} onClick={() => { setForm({...form, ...emptyFilters}); acknowledgeFields(emptyFilters); setError(""); }}>清空筛选</button></div>
        </details>
        <div className="inline-actions"><button type="button" className="text-button subdued" disabled={!!busy || (!instruction && !instructionBaseline)} onClick={() => { setInstruction(""); setInstructionBaseline(""); setError(""); }}>清空方向</button><button type="button" className="button primary small" disabled={disabled || !!busy || running || (!unconfirmed && (!aiConfigured || invalidRange))} onClick={() => void startAI()}>{busy === "ai" ? <Loader2 size={14} className="spin"/> : <Sparkles size={14}/>} {busy === "ai" ? "正在提交…" : running ? "正在查找…" : unconfirmed ? "重试确认任务" : "开始查找"}</button></div>
        </div>
        {invalidRange && <p className="notice" role="alert">结束日期不能早于开始日期。</p>}
        {!aiConfigured && <p className="scope-notice">尚未配置内置 AI，请配置项目的模型接入后使用。你也可以继续手动查找。</p>}
      </div>
    </div>
    <details className="quiet-disclosure manual-discovery">
      <summary><Search size={15}/>按关键词查找</summary>
      <form className="analysis-form" onSubmit={(event) => { event.preventDefault(); void discoverManually(); }}>
        <label>相关概念<textarea aria-label="主题搜索关键词" rows={2} value={form.terms} readOnly={!!busy} placeholder="例如：生态位，差异化，竞争与协作" onChange={(event) => field("terms", event.target.value)}/><small>最多 6 项，用换行或逗号分隔；项内空格为组合检索。</small></label>
        {terms.length > 6 && <p className="notice">最多搜索 6 个概念，请分成几次查找。</p>}
        <div className="inline-actions"><button type="button" className="text-button subdued" disabled={!!busy} onClick={() => { field("terms", ""); acknowledgeFields({terms: ""}); setError(""); }}>清空关键词</button><button className="button secondary small" disabled={disabled || !!busy || running || !!unconfirmed || !terms.length || terms.length > 6 || invalidRange}>{busy === "manual" ? <Loader2 size={14} className="spin"/> : <Search size={14}/>} {busy === "manual" ? "正在查找…" : "查找主题材料"}</button></div>
      </form>
    </details>
    {busy && <p className="discovery-progress" role="status"><Loader2 size={14} className="spin"/><span>{busy === "ai" ? "正在提交后台任务，确认后可以离开页面。" : "正在搜索相关概念并补读笔记全文，请稍候。"}</span></p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {unconfirmed && !busy && <p className="scope-notice">上次提交尚未确认。重试会使用上次的方向和筛选条件；当前输入保留。</p>}
    {discoveryJobs.length > 0 && <section className="discovery-history" aria-label="AI 找材料记录">
      <div role="status"><DiscoveryJobView job={discoveryJobs[0]}/></div>
      {discoveryJobs.length > 1 && <details className="quiet-disclosure"><summary>历史查找<span>{discoveryJobs.length - 1} 次</span></summary>
        {discoveryJobs.slice(1,historyCount + 1).map(job => <details className="discovery-history-item" key={job.id}><summary>{discoveryJobLabel(job)} · {actorLabels[job.actor] ?? job.actor} · {jobDate(job)}</summary><DiscoveryJobView job={job}/></details>)}
        {discoveryJobs.length > historyCount + 1 && <button type="button" className="text-button" onClick={() => setHistoryCount(count => count + 5)}>显示更早的记录</button>}
      </details>}
    </section>}
    {result && <section className="discovery-manual-result" role="status"><details className="quiet-disclosure"><summary>手动查找完成<span>已读 {result.readCount} 条 · 详情</span></summary><DiscoverySummaryView result={result}/></details></section>}
  </section>;
}
