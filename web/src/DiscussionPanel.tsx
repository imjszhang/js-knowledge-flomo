import { randomUUID } from "./browser-compat";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Check, ChevronDown, FileText, History, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { Job, Message, Workspace } from "../../shared/contracts";
import { discussionContext, discussionContextStatus, discussionSources } from "../../shared/discussion";
import { ApiError, api, messageOf, sourceUrl } from "./api";
import { markdownExcerpt } from "./markdown-text";
import Modal from "./Modal";
import { confirmedDiscussionJob, conversationRounds, prepareDiscussionRequest, promptAfterConfirmation, type PendingDiscussionRequest } from "./discussion-state";
import "./discussion.css";

interface DiscussionPanelProps {
  workspace: Workspace;
  aiConfigured: boolean;
  disabled?: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onApply: (content: string, mode: "append" | "replace") => void;
  onNewDraft: (content: string) => Promise<void>;
  onDirty: (dirty: boolean) => void;
  onMaterials: () => void;
  onRefreshMaterials?: () => Promise<Workspace>;
  renderContent: (content: string) => ReactNode;
}

type DiscussionContext = NonNullable<Message["discussionContext"]>;
const updatePrompt = "请基于当前最新的原笔记和已选材料，重新审视我们之前的讨论。指出材料变化对已有判断的影响，保留仍然成立的结论，修正需要调整的部分，并给出值得继续追问的问题。请明确标注所依据的来源。";
const starterPrompt = "结合原笔记和已选材料，帮我找出最值得继续思考的三个问题，并标注对应的来源。";

function readLocal(key: string) {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function writeLocal(key: string, value: string) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* The in-memory input stays editable when storage is unavailable. */ }
}
function readAttempt(key: string): PendingDiscussionRequest | null {
  try {
    const value = JSON.parse(readLocal(key));
    return typeof value.prompt === "string" && Number.isInteger(value.version) && typeof value.key === "string" && ["question", "update"].includes(value.kind) ? value : null;
  } catch { return null; }
}
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function sourceCounts(sources: DiscussionContext["sources"], memoId: string) {
  const notes = sources.filter(source => source.kind === "flomo" && source.id !== memoId).length;
  const articles = sources.filter(source => source.kind === "collector").length;
  return `原笔记 · 已选笔记 ${notes} · 收藏 ${articles}`;
}
export function DiscussionPanel(props: DiscussionPanelProps) {
  return <DiscussionPanelContent key={props.workspace.id} {...props} />;
}

function DiscussionPanelContent({ workspace, aiConfigured, disabled = false, flush, onUpdate, onApply, onNewDraft, onDirty, onMaterials, onRefreshMaterials, renderContent }: DiscussionPanelProps) {
  const client = useQueryClient();
  const storageKey = `flomo-discussion:${workspace.id}`;
  const [prompt, setPrompt] = useState(() => readLocal(storageKey));
  const [busy, setBusy] = useState<"sending" | "saving" | "refreshing" | "newDraft" | null>(null);
  const [error, setError] = useState("");
  const [checkNotice, setCheckNotice] = useState("");
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [pendingRequest, setPendingRequest] = useState(() => readAttempt(`${storageKey}:request`));
  const attempt = useRef<PendingDiscussionRequest | null>(pendingRequest);
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const jobsQuery = useQuery({
    queryKey: ["jobs", workspace.id],
    queryFn: () => api.jobs(workspace.id),
    refetchInterval: query => query.state.data?.some(job => job.kind === "ai" && job.status === "running") ? 1200 : false,
  });
  const aiJobs = (jobsQuery.data ?? []).filter(job => job.kind === "ai").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const runningJob = aiJobs.find(job => job.status === "running");
  const latestJob = aiJobs[0];
  const lastAnswer = [...workspace.messages].reverse().find(message => message.role === "assistant");
  const latestFailure = latestJob && ["failed", "uncertain"].includes(latestJob.status) && (!lastAnswer || latestJob.createdAt >= lastAnswer.createdAt) ? latestJob : null;
  const contextStatus = lastAnswer ? discussionContextStatus(lastAnswer.discussionContext, workspace) : null;
  const sources = discussionSources(workspace);
  const rounds = conversationRounds(workspace.messages, runningJob?.discussionContext);
  const latestRound = rounds.at(-1);
  const history = rounds.slice(0, -1).reverse();
  const unavailable = disabled || !!busy;

  useEffect(() => { writeLocal(storageKey, prompt); }, [storageKey, prompt]);
  useEffect(() => {
    dirtyCallback.current(!!prompt.trim() || !!busy);
    return () => dirtyCallback.current(false);
  }, [prompt, busy]);
  useEffect(() => {
    const pending = attempt.current;
    if (!pending || !confirmedDiscussionJob(pending, jobsQuery.data ?? [], workspace.id)) return;
    setPrompt(current => promptAfterConfirmation(current, pending));
    keepAttempt(null);
    setError("");
    void client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
  }, [jobsQuery.data, workspace.id]);

  function keepAttempt(value: PendingDiscussionRequest | null) {
    attempt.current = value;
    setPendingRequest(value);
    writeLocal(`${storageKey}:request`, value ? JSON.stringify(value) : "");
  }
  function invalidate() {
    void client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    void client.invalidateQueries({ queryKey: ["jobs", workspace.id] });
  }
  async function send(useAI: boolean, kind: "question" | "update" = "question", recover = false) {
    const content = recover && attempt.current ? attempt.current.prompt : kind === "update" ? updatePrompt : prompt.trim();
    if (!content || unavailable || (useAI && !recover && (!aiConfigured || runningJob || attempt.current))) return;
    setBusy(useAI ? "sending" : "saving");
    setError("");
    setCheckNotice("");
    let submitted: PendingDiscussionRequest | null = null;
    try {
      if (useAI) {
        const pending = await prepareDiscussionRequest(attempt.current, content, kind, async () => {
          let saved = await flush();
          if (kind === "update" && onRefreshMaterials) saved = await onRefreshMaterials();
          return saved.version;
        }, () => randomUUID());
        keepAttempt(pending);
        submitted = pending;
        const job = await api.ai(workspace.id, pending.prompt, pending.version, pending.key);
        if (!confirmedDiscussionJob(pending, [job], workspace.id)) throw new Error("返回的讨论任务不匹配，已保留本次请求，请核对提交结果。");
        client.setQueryData<Job[]>(["jobs", workspace.id], current => {
          const existing = current?.find(item => item.id === job.id);
          const newest = existing && (existing.updatedAt > job.updatedAt || (existing.status !== "running" && job.status === "running")) ? existing : job;
          return [newest, ...(current ?? []).filter(item => item.id !== job.id)];
        });
        setPrompt(current => promptAfterConfirmation(current, pending));
        keepAttempt(null);
      } else {
        const saved = await flush();
        onUpdate(await api.message(workspace.id, content, saved.version));
        setPrompt("");
      }
      invalidate();
    } catch (caught) {
      if (submitted && confirmedDiscussionJob(submitted, client.getQueryData<Job[]>(["jobs", workspace.id]) ?? [], workspace.id)) {
        setPrompt(current => promptAfterConfirmation(current, submitted!));
        keepAttempt(null);
        setError("");
      } else {
        if (caught instanceof ApiError && ["VERSION_CONFLICT", "STALE_VERSION", "AI_PENDING", "AI_NOT_CONFIGURED"].includes(caught.code)) keepAttempt(null);
        setError(messageOf(caught));
      }
      invalidate();
    } finally { setBusy(null); }
  }
  async function refreshMaterials() {
    if (!onRefreshMaterials || unavailable) return;
    setBusy("refreshing");
    setError("");
    setCheckNotice("");
    try {
      await flush();
      const before = discussionContext(workspace);
      const saved = await onRefreshMaterials();
      onUpdate(saved);
      setCheckNotice(discussionContextStatus(before, saved) === "current" ? "已检查，当前材料没有变化。" : "已载入最新材料。已有回答会保留，可基于新材料继续讨论。");
      invalidate();
    } catch (caught) { setError(messageOf(caught)); }
    finally { setBusy(null); }
  }
  function renderAnswerContext(context: DiscussionContext | undefined) {
    const status = discussionContextStatus(context, workspace);
    return <div className={`discussion-answer-context ${status}`}>
      <span>{context ? `本次依据：${sourceCounts(context.sources, workspace.memoId)}` : "这条回答未记录当时的材料版本"}</span>
      <span className="discussion-version">{status === "current" ? "与当前依据一致" : status === "stale" ? "讨论依据已变化" : "版本待确认"}</span>
    </div>;
  }
  function renderRound(round: Message[]) {
    return round.map(message => <article key={message.id} className={`discussion-message ${message.role}`}>
      <div className="discussion-message-meta">
        <strong>{message.role === "assistant" ? <><Sparkles size={14} /> AI 的补充</> : "我的思考"}</strong>
        <span>{message.actor !== "web" && <small>{message.actor === "cli" ? "CLI" : "MCP"} · </small>}{date(message.createdAt)}</span>
      </div>
      {message.role === "assistant" && renderAnswerContext(message.discussionContext)}
      <div className="discussion-message-body">{renderContent(message.content)}</div>
      {message.role === "assistant" && <div className="discussion-answer-actions"><button className="text-button" disabled={unavailable} onClick={() => { setError(""); setApplyMessage(message.content); }}><FileText size={13} />用于草稿<ArrowRight size={12} /></button></div>}
    </article>);
  }

  return <section className="discussion-panel" aria-label="讨论与补充">
    <header className="discussion-heading"><h2>讨论与补充</h2><p>把问题说清楚，再把有价值的回答带进草稿。</p></header>

    <section className="discussion-basis" aria-label="讨论依据">
      <div className="discussion-basis-top">
        <div><span className="discussion-eyebrow"><BookOpen size={13} />当前依据</span><p>{sourceCounts(sources, workspace.memoId)}</p></div>
        <button className="text-button" onClick={onMaterials}>查看材料<ArrowRight size={13} /></button>
      </div>
      <div className="discussion-basis-bottom">
        <details className="discussion-source-list"><summary>查看具体来源<ChevronDown size={12} /></summary><ul>{sources.map(source => <li key={source.key}>
          <span>{source.kind === "collector" ? "收藏" : source.id === workspace.memoId ? "原笔记" : "笔记"}</span>
          {sourceUrl(source.url) ? <a href={sourceUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.title || "未命名笔记"}</a> : <strong>{source.title || "未命名笔记"}</strong>}
        </li>)}</ul><p className="discussion-selection-hint">使用原笔记和已选材料；待选推荐与仅建立链接的笔记不会自动加入。</p></details>
        {onRefreshMaterials && <button className="text-button subdued" disabled={unavailable} onClick={() => void refreshMaterials()}>{busy === "refreshing" ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{busy === "refreshing" ? "正在检查…" : "检查材料更新"}</button>}
      </div>
      <p className="discussion-basis-hint">增减材料会影响下一次讨论；在 flomo 修改内容后，可在这里检查更新。</p>
      {checkNotice && <p className="discussion-check-notice" role="status"><Check size={13} />{checkNotice}</p>}
    </section>

    {contextStatus && contextStatus !== "current" && <aside className={`discussion-update ${contextStatus}`}>
      <div><strong>{contextStatus === "stale" ? "讨论依据已变化，上一轮回答还没有更新" : "上一轮回答的材料版本待确认"}</strong><p>{contextStatus === "stale" ? "材料、目标或草稿有了变化。已有讨论会保留，可以请 AI 重新核对判断。" : "这条旧回答没有记录来源快照，可以用当前材料重新讨论。"}</p></div>
      <button className="button secondary small" disabled={unavailable || !aiConfigured || !!runningJob || !!pendingRequest} onClick={() => void send(true, "update")}><RefreshCw size={13} />基于最新材料更新讨论</button>
    </aside>}

    <form className="discussion-composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void send(true); }}>
      <label htmlFor={`discussion-prompt-${workspace.id}`}>继续想一想</label>
      <textarea ref={textarea} id={`discussion-prompt-${workspace.id}`} aria-label="讨论问题" rows={3} value={prompt} readOnly={unavailable} placeholder="提出一个问题，或记下你对这些材料的判断…" onChange={event => setPrompt(event.target.value)} />
      <div className="discussion-composer-actions"><span>{prompt ? "输入已在本机保留" : "保存思考会记入讨论，不调用 AI"}</span><div><button type="button" className="text-button" disabled={!prompt.trim() || unavailable} onClick={() => void send(false)}>{busy === "saving" ? "正在保存…" : "保存思考"}</button><button type="submit" className="button primary small" disabled={!prompt.trim() || unavailable || !aiConfigured || !!runningJob || !!pendingRequest}>{busy === "sending" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{runningJob ? "AI 正在思考…" : "请 AI 一起想"}</button></div></div>
      {!aiConfigured && <p className="discussion-ai-note">尚未配置内置 AI。你可以先保存思考，也可以让 Codex 从 CLI 或 MCP 接着讨论。</p>}
    </form>

    {pendingRequest && !busy && <aside className="discussion-pending"><strong>上次提交的结果尚未确认</strong><p>先核对这次请求，再发起新的 AI 讨论。你可以继续编辑输入。</p><button className="text-button" disabled={unavailable} onClick={() => void send(true, pendingRequest.kind, true)}>核对并恢复这次提交<ArrowRight size={13} /></button></aside>}

    {error && <div className="error-box" role="alert">{error}</div>}
    {jobsQuery.error && <div className="error-box" role="alert"><span>暂时无法读取讨论进度，输入已保留。</span><button className="text-button" onClick={() => void jobsQuery.refetch()}>重试</button></div>}

    {!latestRound && !runningJob && !latestFailure && <div className="discussion-empty"><Sparkles size={20} /><h3>从一个值得追问的问题开始</h3><p>结合原笔记和已选材料，展开想法、比较观点，或寻找下一步。</p><button className="text-button" disabled={unavailable || !!prompt.trim()} onClick={() => { setPrompt(starterPrompt); textarea.current?.focus(); }}>帮我找到值得追问的问题<ArrowRight size={13} /></button></div>}

    {(latestRound || runningJob || latestFailure) && <section className="discussion-latest" aria-label="最新讨论"><div className="discussion-section-title"><h3>最新讨论</h3><span>有价值的补充，可以随时用于草稿</span></div>
      {latestRound && renderRound(latestRound)}
      {runningJob && <article className="discussion-message assistant discussion-generating"><div className="discussion-message-meta"><strong><Loader2 size={14} className="spin" />正在结合材料思考…</strong></div>{renderAnswerContext(runningJob.discussionContext)}{runningJob.text ? <div className="discussion-message-body">{renderContent(runningJob.text)}</div> : <p className="discussion-waiting" role="status">回答会在这里逐步出现，你可以先查看其他页面。</p>}</article>}
      {latestFailure && <div className="discussion-failure" role="status"><strong>这次讨论未能完成</strong><p>{latestFailure.error || "可以保留当前思路，稍后重新发起讨论。"}</p>{latestFailure.text && <details><summary>查看已生成的内容</summary>{renderContent(latestFailure.text)}</details>}</div>}
    </section>}

    {history.length > 0 && <details className="discussion-history"><summary><History size={14} /><strong>之前的讨论</strong><span>{history.length} 轮</span><ChevronDown size={14} /></summary><div>{history.map(round => <details className="discussion-history-round" key={round[0].id}><summary><span>{markdownExcerpt(round[0].content, 80)}</span><small>{date(round[0].createdAt)}</small><ChevronDown size={13} /></summary>{renderRound(round)}</details>)}</div></details>}

    {applyMessage !== null && <Modal title="将回答用于草稿" onClose={() => { if (!busy) setApplyMessage(null); }}><p className="modal-description">先核对回答，再选择它在草稿中的位置。</p><div className="apply-preview">{renderContent(applyMessage)}</div>{error && <div className="error-box" role="alert">{error}</div>}<div className="modal-actions"><button className="button primary" disabled={unavailable} onClick={() => { setBusy("newDraft"); setError(""); void onNewDraft(applyMessage).then(() => setApplyMessage(null)).catch(caught => setError(messageOf(caught))).finally(() => setBusy(null)); }}>{busy === "newDraft" ? "正在保存…" : "另存为新笔记草稿"}</button><button className="button secondary" disabled={unavailable} onClick={() => { onApply(applyMessage, "append"); setApplyMessage(null); }}>追加到当前笔记</button><button className="button secondary" disabled={unavailable} onClick={() => { onApply(applyMessage, "replace"); setApplyMessage(null); }}>替换当前笔记草稿</button></div></Modal>}
  </section>;
}
