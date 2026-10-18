import { randomUUID, writeClipboardText } from "./browser-compat";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  Clock3,
  FileText,
  Hash,
  Layers3,
  Link2,
  Loader2,
  MessageCircle,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import type { ActiveContext, Decision, DraftRevision, Job, MaterialCandidate, Memo, Settings, WorkbenchView, Workspace } from "../../shared/contracts";
import { pinnedTags } from "../../shared/contracts";
import { ApiError, api, messageOf, sourceUrl } from "./api";
import { useChanges, useDebounce, useDraft } from "./hooks";
import InlineDiff from "./InlineDiff";
import Modal from "./Modal";
import { markdownExcerpt as excerpt } from "./markdown-text";
import { AnalysisPanel } from "./AnalysisPanel";
import {AnalysisCardDraft} from "./AnalysisCardDraft";
import NoteDraftEditor from "./NoteDraftEditor";
import {useAnalysisInput} from "./analysis-forms";
import { TopicDiscovery } from "./TopicDiscovery";
import { CollectorMaterialCard, CollectorSources } from "./CollectorSources";
import { NoteLinkDialog, NoteLinksPanel } from "./NoteLinks";
import { LinkedMemos } from "./LinkedMemos";
import { DiscussionPanel } from "./DiscussionPanel";

type LeaveGuard = () => Promise<unknown>;
const viewLabels: Record<WorkbenchView, string> = { note: "笔记", materials: "材料", discussion: "讨论", writing: "写作", draft: "草稿" };

function date(value: string | undefined, detailed = false) {
  if (!value) return "尚未检查";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(
    "zh-CN",
    detailed
      ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "numeric", day: "numeric" },
  );
}

function Loading({ label = "正在读取…" }: { label?: string }) {
  return (
    <div className="loading">
      <Loader2 size={18} className="spin" />
      {label}
    </div>
  );
}

function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <span>{typeof error === "string" ? error : messageOf(error)}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt, src }) => (
            <a
              href={sourceUrl(src ?? "")}
              target="_blank"
              rel="noopener noreferrer"
            >
              [图片{alt ? `：${alt}` : ""}]
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function MemoLink({
  memo,
  children = "在 flomo 中查看",
}: {
  memo: Memo;
  children?: ReactNode;
}) {
  const url = sourceUrl(memo.url);
  return url ? (
    <a
      className="text-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  ) : null;
}


function useSavedFilter<T extends string | boolean>(name: string, fallback: T) {
  const key = `flomo:filters:${name}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      return typeof saved === typeof fallback ? saved as T : fallback;
    } catch { return fallback; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
  }, [key, value]);
  return [value, setValue] as const;
}

export function App() {
  const client = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const context = useQuery({ queryKey: ["context"], queryFn: api.context });
  const initialId = useRef(new URLSearchParams(location.search).get("workspace"));
  const [workspaceId, setWorkspaceId] = useState<string | null>(initialId.current);
  const [view, setView] = useState<WorkbenchView>("note");
  const [ready, setReady] = useState(false);
  const [tag, setTag] = useSavedFilter<string>("library.tag", "待编");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySection, setLibrarySection] = useState<"notes" | "workspaces">("notes");
  const [navigationError, setNavigationError] = useState("");
  const guard = useRef<LeaveGuard | null>(null);
  const initialized = useRef(false);
  const navigating = useRef(false);
  const connection = useChanges();
  const selectedWorkspace = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspace(workspaceId!), enabled: !!workspaceId,
  });
  const tags = settings.data?.pinnedTags ?? [...pinnedTags];

  function selectLocal(id: string | null, nextView: WorkbenchView, replace = false) {
    setWorkspaceId(id); setView(nextView); setLibraryOpen(false);
    const url = new URL(location.href);
    if (id) url.searchParams.set("workspace", id);
    else url.searchParams.delete("workspace");
    history[replace ? "replaceState" : "pushState"]({}, "", url);
  }
  async function navigate(id: string | null, nextView: WorkbenchView = "note", replace = false, adopt = false) {
    if (navigating.current) return;
    navigating.current = true;
    try {
      if (id !== workspaceId && guard.current) await guard.current();
      if (!adopt) {
        const current = client.getQueryData<ActiveContext>(["context"]) ?? await api.context();
        if (current.workspaceId !== id || current.view !== nextView) {
          const saved = await api.setContext(id, nextView, current.revision);
          client.setQueryData(["context"], saved);
        }
      }
      selectLocal(id, nextView, replace); setNavigationError("");
    } catch (error) {
      setNavigationError(messageOf(error));
      const restored = new URL(location.href);
      if (workspaceId) restored.searchParams.set("workspace", workspaceId);
      else restored.searchParams.delete("workspace");
      history.replaceState({}, "", restored);
      void client.invalidateQueries({ queryKey: ["context"] });
    } finally { navigating.current = false; }
  }
  useEffect(() => {
    if (initialized.current || !context.data || !workspaces.data) return;
    initialized.current = true;
    const chosen = initialId.current ?? context.data.workspaceId ?? workspaces.data[0]?.id ?? null;
    const nextView = chosen === context.data.workspaceId ? context.data.view : "note";
    selectLocal(chosen, nextView, true); setReady(true);
    if (chosen !== context.data.workspaceId) {
      void api.setContext(chosen, nextView, context.data.revision)
        .then((saved) => client.setQueryData(["context"], saved))
        .catch((error) => { setNavigationError(`当前工作未同步：${messageOf(error)}`); void context.refetch(); });
    }
  }, [context.data, workspaces.data]);
  useEffect(() => {
    const pop = () => {
      const nextId = new URLSearchParams(location.search).get("workspace");
      void (async () => {
        try {
          if (guard.current && nextId !== workspaceId) await guard.current();
          await navigate(nextId, "note", true);
        } catch (error) {
          selectLocal(workspaceId, view, true); setNavigationError(messageOf(error));
        }
      })();
    };
    addEventListener("popstate", pop); return () => removeEventListener("popstate", pop);
  }, [workspaceId, view]);
  async function openMemo(memo: Memo) {
    if (guard.current) await guard.current();
    const existing = workspaces.data?.find((item) => item.memoId === memo.id);
    const opened = existing ?? await api.createWorkspace(memo.id);
    client.setQueryData(["workspace", opened.id], opened);
    await client.invalidateQueries({ queryKey: ["workspaces"] });
    await navigate(opened.id);
  }
  const offered = ready && context.data && (context.data.workspaceId !== workspaceId || context.data.view !== view) ? context.data : null;
  return (
    <div className="companion-shell">
      <header className="companion-header">
        <button className="workspace-switcher" onClick={() => { setLibrarySection("notes"); setLibraryOpen(true); }} aria-label="选择笔记或切换工作区">
          <span className="brand-dot"><BookOpen size={16} /></span>
          <span>flomo 工作台</span><ChevronDown size={14} />
        </button>
        <div className="header-status" title={connection.connected ? "Web、CLI 和 MCP 共用当前工作" : "连接中，正在重连"}>
          <span className={`status-dot ${connection.connected ? "online" : ""}`} /><span>{connection.connected ? "已连接" : "重连中"}</span>
        </div>
        <button className="icon-button" aria-label="工作台设置" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>
      </header>
      <div className="companion-content">
        <ErrorBox error={navigationError || context.error || workspaces.error} retry={context.isError || workspaces.isError ? () => { void context.refetch(); void workspaces.refetch(); } : undefined} />
        {offered && <div className="notice context-notice" role="status"><div><strong>另一端切换了当前工作</strong><p>{offered.workspace?.title ?? "笔记选择"} · {viewLabels[offered.view]}</p></div><div className="inline-actions"><button className="text-button" onClick={() => void navigate(workspaceId, view, true)}>留在这里</button><button className="button secondary small" onClick={() => void navigate(offered.workspaceId, offered.view, false, true)}>跟随查看</button></div></div>}
        {!ready && !context.isError && !workspaces.isError ? <Loading label="正在恢复当前工作…" /> : workspaceId ? (
          selectedWorkspace.isPending ? <Loading label="正在打开笔记…" /> : !selectedWorkspace.data ? <div className="page-error"><ErrorBox error={selectedWorkspace.error} retry={() => void selectedWorkspace.refetch()} /><button className="button secondary" onClick={() => setLibraryOpen(true)}>选择其他笔记</button></div> :
          <><ErrorBox error={selectedWorkspace.error} retry={() => void selectedWorkspace.refetch()} /><Workbench key={workspaceId} workspace={selectedWorkspace.data} view={view} onView={(next) => void navigate(workspaceId, next, true)} aiConfigured={health.data?.aiConfigured ?? false} collectorConfigured={health.data?.collectorConfigured} setGuard={(value) => { guard.current = value; }} /></>
        ) : ready ? <section className="welcome-panel"><div className="empty-icon"><FileText size={24} /></div><h1>这次想把哪条笔记想清楚？</h1><p>选一条待编，在 Codex 对话中推进。材料、你的选择和草稿会保留在这里。</p><button className="button primary" onClick={() => setLibraryOpen(true)}>选择一条笔记<ArrowRight size={15} /></button><div className="welcome-steps"><span>读笔记</span><ArrowRight size={13}/><span>选材料</span><ArrowRight size={13}/><span>完善草稿</span></div></section> : null}
      </div>
      {libraryOpen && <Modal title="选择要继续的工作" onClose={() => setLibraryOpen(false)} drawer>
        <div className="segmented drawer-tabs"><button className={librarySection === "notes" ? "selected" : ""} onClick={() => setLibrarySection("notes")}>从笔记开始</button><button className={librarySection === "workspaces" ? "selected" : ""} onClick={() => setLibrarySection("workspaces")}>继续加工 <span>{workspaces.data?.length ?? 0}</span></button></div>
        {librarySection === "notes" ? <><nav className="tag-navigation" aria-label="置顶标签">{[...tags, ""].map((item) => <button key={item} className={tag === item ? "selected" : ""} onClick={() => setTag(item)}>{item || "全部"}</button>)}</nav><Library tag={tag} onOpen={openMemo} flomoConfigured={health.data?.flomoConfigured} /></> : <div className="workspace-list">{workspaces.data?.length ? workspaces.data.map((item) => <button key={item.id} className={`workspace-row ${item.id === workspaceId ? "selected" : ""}`} onClick={() => void navigate(item.id)}><div><strong>{excerpt(item.title, 200)}</strong><p>{item.goal || excerpt(item.draft, 90)}</p><span>{date(item.updatedAt, true)} · {item.materials.length + (item.collectorMaterials?.length ?? 0)} 条材料</span></div><ArrowRight size={16}/></button>) : <div className="empty-state"><h3>还没有加工中的笔记</h3><p>从置顶标签中选择一条笔记即可开始。</p><button className="text-button" onClick={() => setLibrarySection("notes")}>选择笔记<ArrowRight size={14}/></button></div>}</div>}
        <ErrorBox error={navigationError}/>
      </Modal>}
      {settingsOpen && <SettingsDialog settings={settings.data} aiConfigured={health.data?.aiConfigured ?? false} flomoConfigured={health.data?.flomoConfigured ?? false} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function Library({
  tag,
  onOpen,
  flomoConfigured,
}: {
  tag: string;
  onOpen: (memo: Memo) => Promise<void>;
  flomoConfigured?: boolean;
}) {
  const [search, setSearch] = useSavedFilter<string>("library.search", "");
  const [unlinkedOnly, setUnlinkedOnly] = useSavedFilter<boolean>("library.unlinkedOnly", false);
  const [startDate, setStartDate] = useSavedFilter<string>("library.startDate", "");
  const [endDate, setEndDate] = useSavedFilter<string>("library.endDate", "");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const query = useDebounce(search);
  const invalidRange = !!startDate && !!endDate && startDate > endDate;
  const memos = useQuery({
    queryKey: ["memos", tag, query, startDate, endDate, unlinkedOnly],
    queryFn: () =>
      api.memos({ q: query, tag, startDate, endDate, unlinkedOnly: String(unlinkedOnly), limit: "50" }),
    enabled: !invalidRange,
  });
  return (
    <main className="library">
      <div className="library-tools">
        <label className="search-input">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tag ? `在「${tag}」中搜索笔记…` : "搜索笔记内容…"}
            aria-label="搜索笔记"
          />
          {search && (
            <button
              className="icon-button"
              onClick={() => setSearch("")}
              aria-label="清空搜索"
            >
              <X size={14} />
            </button>
          )}
        </label>
        <button
          className="button secondary refresh-button"
          onClick={() => void memos.refetch()}
          disabled={memos.isFetching || invalidRange}
        >
          <RefreshCw size={15} className={memos.isFetching ? "spin" : ""} />
          刷新
        </button>
      </div>
      <div className="library-filters">
        <div className="scope-label">
          <span className="tag-chip">#{tag || "全部"}</span>
          <span>{tag ? "包含子标签" : "远端搜索"}</span>
        </div>
        <div className="date-filters">
          <input
            type="date"
            aria-label="开始日期"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
          <span>—</span>
          <input
            type="date"
            aria-label="结束日期"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
          {(startDate || endDate) && (
            <button
              className="icon-button"
              aria-label="清除日期筛选"
              onClick={() => {
                setStartDate("");
                setEndDate("");
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <label className="unlinked-filter"><input type="checkbox" checked={unlinkedOnly} onChange={event => setUnlinkedOnly(event.target.checked)}/>只看尚未双链的笔记<span>外部网页链接不算</span></label>
      {flomoConfigured === false && (
        <div className="notice">
          请先在项目环境中配置 flomo 接入。已有工作区和本地草稿仍可打开。
        </div>
      )}
      <ErrorBox
        error={
          error || (invalidRange ? "开始日期不能晚于结束日期。" : memos.error)
        }
        retry={memos.isError ? () => void memos.refetch() : undefined}
      />
      <div className="section-heading">
        <h2>
          {query ? "搜索结果" : tag ? `${tag}笔记` : "最近的笔记"}{" "}
          <span>{memos.data?.memos.length ?? "—"}</span>
        </h2>
        <span>
          {memos.data
            ? `检查于 ${date(memos.data.checkedAt, true)}`
            : "从 flomo 读取"}
        </span>
      </div>
      {memos.isPending && !invalidRange ? (
        <Loading label="正在从 flomo 查找笔记…" />
      ) : (
        memos.data &&
        !invalidRange && (
          <>
            {memos.data.possiblyLimited && (
              <div className="scope-notice">
                本次展示最多 {memos.data.limit}{" "}
                条搜索结果，不代表完整知识库。可以缩小日期或关键词范围继续查找。
              </div>
            )}
            {memos.data.memos.length === 0 ? (
              <div className="empty-state">
                <BookOpen size={30} />
                <h3>{unlinkedOnly ? "本次返回结果中没有尚未双链的笔记" : "还没有找到相关笔记"}</h3>
                <p>换一个关键词，或试着扩大日期范围。</p>
              </div>
            ) : (
              <div className="memo-grid">
                {memos.data.memos.map((memo, index) => (
                  <article key={memo.id} className="memo-card">
                    <div className="memo-card-top">
                      <span>{date(memo.created_at)}</span>
                      <span className="memo-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <button
                      className="memo-content-button"
                      disabled={!!opening}
                      onClick={() => {
                        setOpening(memo.id);
                        setError("");
                        void onOpen(memo)
                          .catch((error) => setError(messageOf(error)))
                          .finally(() => setOpening(null));
                      }}
                    >
                      <p>{excerpt(memo.content, 270) || "打开查看笔记全文"}</p>
                    </button>
                    <div className="memo-tags">
                      {memo.tags.slice(0, 4).map((item) => (
                        <span key={item}>#{item}</span>
                      ))}
                    </div>
                    <div className="memo-card-footer">
                      <MemoLink memo={memo}>原笔记</MemoLink>
                      <button
                        className="text-button"
                        disabled={!!opening}
                        onClick={() => {
                          setOpening(memo.id);
                          setError("");
                          void onOpen(memo)
                            .catch((error) => setError(messageOf(error)))
                            .finally(() => setOpening(null));
                        }}
                      >
                        {opening === memo.id ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <>
                            开始加工
                            <ArrowRight size={14} />
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )
      )}
      <footer className="library-footer">
        <Terminal size={14} />
        <span>也可以让 Codex 通过 CLI 加工笔记，结果会同步出现在工作台。</span>
      </footer>
    </main>
  );
}

function Workbench({ workspace, view, onView, aiConfigured, collectorConfigured, setGuard }: {
  workspace: Workspace; view: WorkbenchView; onView: (view: WorkbenchView) => void;
  aiConfigured: boolean; collectorConfigured: boolean | undefined; setGuard: (guard: LeaveGuard | null) => void;
}) {
  const client = useQueryClient();
  const editor = useDraft(workspace);
  const [preview, setPreview] = useState(false);
  const [draftChoice, setDraftChoice] = useAnalysisInput<string>(`flomo:draft-choice:${workspace.id}`, 'source');
  const newDraftPending = useRef(false);
  const newDraftAttempt = useRef<{signature:string;version:number;key:string}|null>(null);
  const [materialSearch, setMaterialSearch] = useState(false);
  const [linkDialog, setLinkDialog] = useState<{target?:Memo} | null>(null);
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const [discoveryOpen, setDiscoveryOpen] = useState(() => !(workspace.materialCandidates?.length || workspace.materials.length || workspace.collectorMaterials?.length));
  const [materialFilter, setMaterialFilter] = useState<"proposed" | "selected" | "dismissed">(() => (workspace.materialCandidates ?? []).some(item => item.status === "proposed") || !workspace.materials.length && !workspace.collectorMaterials?.length ? "proposed" : "selected");
  const [remoteCompare, setRemoteCompare] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [publishPreview, setPublishPreview] = useState<Workspace | null>(null);
  const [publishKey, setPublishKey] = useState("");
  const [copyLabel, setCopyLabel] = useState("复制 Codex 读取命令");
  const [abandonJob, setAbandonJob] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState<DraftRevision | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{version:number; content:string} | null>(null);
  const goalDirty = useRef(false);
  const unsavedInputs = useRef(new Set<string>());
  const [dirtyInputs, setDirtyInputs] = useState(new Set<string>());
  function trackInput(key: string, dirty: boolean) {
    if (unsavedInputs.current.has(key) === dirty) return;
    if (dirty) unsavedInputs.current.add(key); else unsavedInputs.current.delete(key);
    setDirtyInputs(new Set(unsavedInputs.current));
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsavedInputs.current.size) { event.preventDefault(); event.returnValue = ""; }
    };
    addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn);
  }, []);
  const checkedOnOpen = useRef(false);
  const jobs = useQuery({ queryKey: ["jobs", workspace.id], queryFn: () => api.jobs(workspace.id), refetchInterval: (query) => query.state.data?.some((job) => job.status === "running") ? 1500 : false });
  const linkJobs = useQuery({ queryKey: ["jobs", "links", workspace.id], queryFn: () => api.links(workspace.id), refetchInterval: query => query.state.data?.some(job => job.status === "running") ? 1500 : false });
  const pendingLinks = (linkJobs.data ?? []).filter(job => job.status === "running" || job.status === "uncertain");
  const discoveryCompletions = jobs.data?.filter(job => job.kind === "discovery" && job.status === "succeeded").map(job => `${job.id}:${job.updatedAt}`).sort().join("|");
  useEffect(() => {
    if (!discoveryCompletions) return;
    void client.invalidateQueries({queryKey:["workspace",workspace.id]});
    void client.invalidateQueries({queryKey:["workspaces"]});
  }, [discoveryCompletions, client, workspace.id]);
  const revisions = useQuery({ queryKey: ["revisions", workspace.id], queryFn: () => api.revisions(workspace.id) });
  const activeJobs = jobs.data?.filter((job) => job.kind !== "link" && (view !== "discussion" || job.kind !== "ai") && (job.status === "running" || job.status === "uncertain")) ?? [];
  const historyJobs = (jobs.data ?? []).filter(job => job.kind !== "link" && (view !== "discussion" || job.kind !== "ai") && (job.status === "succeeded" || job.status === "failed"));
  const latestWorkspace = editor.acknowledged.version > workspace.version ? editor.acknowledged : workspace;
  const noteDrafts = latestWorkspace.noteDrafts ?? [];
  const cardDrafts = (latestWorkspace.analyses ?? []).flatMap(record=>record.cards.map(card=>({record,card,key:`card:${record.id}:${card.id}`})));
  const createdAnnotations = (jobs.data ?? []).filter(job=>job.kind === 'annotation' && job.resultMemo);
  const activeDraftChoice = draftChoice === 'source' || noteDrafts.some(draft=>`note:${draft.id}` === draftChoice) || cardDrafts.some(item=>item.key === draftChoice) || createdAnnotations.some(job=>`annotation:${job.id}` === draftChoice) ? draftChoice : 'source';
  const draftsPublishing = noteDrafts.some(draft=>draft.status === 'publishing') || cardDrafts.some(item=>item.card.status === 'publishing');
  useEffect(()=>{
    if(!draftsPublishing) return;
    const timer=setInterval(()=>void client.invalidateQueries({queryKey:['workspace',workspace.id]}),1500);
    return ()=>clearInterval(timer);
  },[draftsPublishing,client,workspace.id]);
  const candidates = latestWorkspace.materialCandidates ?? [];
  const selected = latestWorkspace.materials;
  const collectorMaterials = latestWorkspace.collectorMaterials ?? [];
  const selectedCount = selected.length + collectorMaterials.length;
  const proposed = candidates.filter((item) => item.status === "proposed");
  const dismissed = candidates.filter((item) => item.status === "dismissed");
  const discoveryJobs = (jobs.data ?? []).filter(job => job.kind === "discovery").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const discoveryRunning = discoveryJobs.some(job => job.status === "running");
  const latestDiscovery = discoveryJobs[0];
  const decisions = latestWorkspace.decisions ?? [];
  const pendingDecisions = decisions.filter((item) => !item.answer);
  const decisionsToReview = decisions.filter((item) => !item.answer || dirtyInputs.has(`decision:${item.id}`));
  const latestRevision = revisions.data?.[0];

  useEffect(() => {
    setGuard(async () => {
      if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑。");
      if (unsavedInputs.current.size) throw new Error("还有未保存的输入，请先保存或清空后再切换笔记。");
      if (editor.session.dirty) await editor.session.flush();
    });
    return () => setGuard(null);
  }, [editor.session]);
  useEffect(() => {
    if (checkedOnOpen.current || !jobs.isSuccess || jobs.data.some((job) => (["publish","link"].includes(job.kind) && (job.status === "running" || job.status === "uncertain")) || (job.kind === "discovery" && job.status === "running"))) return;
    checkedOnOpen.current = true;
    if (Date.now() - Date.parse(workspace.lastCheckedAt) <= 60_000) return;
    void api.refresh(workspace.id).then(update).catch((error) => setError(`检查 flomo 更新失败，已保留本地内容：${messageOf(error)}`));
  }, [jobs.isSuccess, jobs.data, workspace.id, workspace.lastCheckedAt]);
  function update(next: Workspace) {
    client.setQueryData<Workspace>(["workspace", next.id], (previous) => !previous || previous.version <= next.version ? next : previous);
    editor.session.receive(next);
    void client.invalidateQueries({ queryKey: ["workspaces"] });
    void client.invalidateQueries({ queryKey: ["revisions", next.id] });
  }
  async function action(name: string, operation: () => Promise<unknown>) {
    setBusy(name); setError("");
    try { await operation(); }
    catch (error) { setError(messageOf(error)); void client.invalidateQueries({ queryKey: ["workspace", workspace.id] }); }
    finally { setBusy(null); }
  }
  async function createNoteDraft(content = '', originAnalysisId?:string) {
    if(busy || newDraftPending.current) throw new Error('正在保存，请稍后再试。');
    newDraftPending.current=true;trackInput('new-note-create',true);
    setBusy('new-note');setError('');
    try {
      const saved=await editor.session.flush();
      const title=content.trim() ? (saved.analyses?.find(record=>record.id === originAnalysisId)?.writing?.claim || excerpt(content,100).split(/[\n。！？]/)[0]).slice(0,60) : '';
      const input={title,content,originAnalysisId};
      const signature=JSON.stringify(input);
      if(newDraftAttempt.current?.signature !== signature) newDraftAttempt.current={signature,version:saved.version,key:randomUUID()};
      const attempt=newDraftAttempt.current;
      const next=await api.createNoteDraft(workspace.id,{...input,baseVersion:attempt.version,idempotencyKey:attempt.key});
      update(next);
      const created=next.noteDrafts?.find(draft=>draft.idempotencyKey === attempt.key);
      if(!created) throw new Error('未能确认新草稿，请刷新列表核对。');
      newDraftAttempt.current=null;
      setDraftChoice(`note:${created.id}`);onView('draft');
    } catch(error) {
      if(error instanceof ApiError && error.status >= 400 && error.status < 500) newDraftAttempt.current=null;
      setError(messageOf(error));void client.invalidateQueries({queryKey:['workspace',workspace.id]});throw error;
    } finally {newDraftPending.current=false;trackInput('new-note-create',false);setBusy(null);}
  }
  function applyToSource(content:string,mode:'append'|'replace') {
    if(mode === 'append') editor.session.append(content);else editor.session.edit(content);
    setDraftChoice('source');setPreview(false);onView('draft');
  }
  async function preparePublish() {
    await action("preview", async () => {
      await editor.session.flush();
      const latest = await api.refresh(workspace.id); update(latest);
      if (editor.session.getSnapshot().conflict || editor.session.getSnapshot().review) throw new Error("另一端已修改草稿，请先查看更新。");
      setPublishPreview(latest); setPublishKey(randomUUID());
    });
  }
  async function publish() {
    if (!publishPreview) return;
    await action("publish", async () => {
      const job = await api.publish(workspace.id, publishPreview.version, publishKey);
      client.setQueryData<Job[]>(["jobs", workspace.id], (previous) => [job, ...(previous ?? []).filter((item) => item.id !== job.id)]);
      setPublishPreview(null); void client.invalidateQueries({ queryKey: ["jobs", workspace.id] });
    });
  }
  async function chooseMaterial(memo: Memo, status: MaterialCandidate["status"]) {
    await action("material", async () => {
      const saved = await editor.session.flush();
      if (candidates.some((item) => item.memo.id === memo.id)) update(await api.chooseCandidate(workspace.id, memo.id, status, saved.version));
      else update(await api.materials(workspace.id, status === "selected" ? Array.from(new Set([...saved.materials.map((item) => item.id), memo.id])) : saved.materials.filter((item) => item.id !== memo.id).map((item) => item.id), saved.version));
    });
  }
  async function attachSource(articleId: string) {
    await action("collector", async () => {
      const saved = await editor.session.flush();
      update(await api.attachSource(workspace.id, articleId, saved.version));
      void client.invalidateQueries({ queryKey: ["collectorArticle", articleId] });
    });
  }
  async function selectLinkedMemo(memo: Memo) {
    await action("material", async () => {
      const saved = await editor.session.flush();
      // Read the full note again, even when an older recommendation already exists.
      update(await api.materials(workspace.id, Array.from(new Set([...saved.materials.map(item => item.id), memo.id])), saved.version));
    });
  }
  async function removeSource(articleId: string) {
    await action("collector", async () => {
      const saved = await editor.session.flush();
      update(await api.removeSource(workspace.id, articleId, saved.version));
    });
  }
  function sourceAssociations(scope: "source" | "all") {
    return <CollectorSources workspace={latestWorkspace} configured={collectorConfigured} scope={scope} disabled={!!busy} onAttach={attachSource} renderContent={(content) => <Markdown>{content}</Markdown>}/>;
  }
  function materialCard(memo: Memo, candidate?: MaterialCandidate) {
    const status = candidate?.status ?? "selected";
    const firstLine = excerpt(memo.content, 600).split("\n").map(line => line.trim()).find(line => line && !/^#\S+(\s+#\S+)*$/.test(line)) || "未命名材料";
    const title = firstLine.replace(/^\*{1,2}|\*{1,2}$/g, "");
    const reason = candidate?.reason.replace(/^AI\s*推荐[：:]\s*/, "");
    const linked = (latestWorkspace.remote ?? latestWorkspace.source).linked_memos.includes(memo.id) || memo.linked_memos.includes(workspace.memoId);
    return <article className={`context-card ${status}`} key={memo.id}>
      <div className="material-meta"><span className={`relation-chip ${candidate?.relation ?? "background"}`}>{candidate ? relationLabels[candidate.relation] : "参考材料"}</span><span>{date(memo.created_at)}</span>{status === "selected" && <span className="selected-label"><Check size={12}/>已选用</span>}</div>
      <h3 className="material-title">{title.length > 100 ? `${title.slice(0, 100)}…` : title}</h3>
      {reason ? <details className="material-reason-disclosure"><summary><span className="material-reason-preview">{reason}</span><span className="reason-toggle"><span className="reason-closed">展开关联理由</span><span className="reason-open">收起关联理由</span><ChevronDown size={12}/></span></summary><p>{reason}</p></details> : <p className="material-preview">{excerpt(memo.content, 150)}</p>}
      <details className="material-reading compact-reading"><summary><span className="expand-label"><BookOpen size={13}/><span className="when-collapsed">阅读原文</span><span className="when-expanded">收起原文</span><ChevronDown size={12}/></span></summary><Markdown>{memo.content}</Markdown>{memo.content_truncated && <p className="scope-notice">此材料尚未读取完整，请在 flomo 中核对原文。</p>}<MemoLink memo={memo}/></details>
      <div className="material-actions"><button className="text-button" disabled={!!busy} title={linked ? "查看或补充笔记之间的引用" : "预览并将链接写入 flomo 笔记"} onClick={() => setLinkDialog({target:memo})}><Link2 size={13}/>{linked ? "已关联" : "建立关联"}</button>{status === "selected" ? <button className="text-button subdued" disabled={!!busy} onClick={() => void chooseMaterial(memo, "dismissed")}>移出材料</button> : <>{status === "proposed" && <button className="text-button subdued" disabled={!!busy} onClick={() => void chooseMaterial(memo, "dismissed")}>暂时不用</button>}<button className="button secondary small select-material" disabled={!!busy} onClick={() => void chooseMaterial(memo, "selected")}><Plus size={13}/>选用</button></>}</div>
    </article>;
  }
  const saveStatus = editor.saving ? "保存中…" : editor.conflict ? "有版本冲突" : editor.review ? "有新版本待查看" : editor.error ? "保存失败" : editor.dirty ? "尚未保存" : "已自动保存";
  return (
    <main className="workbench">
      <section className="current-work">
        <h1>{excerpt(workspace.title, 200)}</h1>
        <div className="work-meta"><MemoLink memo={workspace.source}>来源笔记</MemoLink><span>{date(workspace.source.created_at)}</span><details className="work-options"><summary aria-label="当前工作操作">更多<ChevronDown size={12}/></summary><div><button disabled={!!busy} onClick={() => void action("refresh", async () => update(await api.refresh(workspace.id)))}><RefreshCw size={13} className={busy === "refresh" ? "spin" : ""}/>检查 flomo 更新</button><button onClick={() => { void writeClipboardText(`npm run --silent workbench -- workspace get ${workspace.id} --json`).then(() => { setCopyLabel("已复制"); setTimeout(() => setCopyLabel("复制 Codex 读取命令"), 2000); }).catch(error => setError(messageOf(error))); }}><Terminal size={13}/>{copyLabel}</button><p>草稿版本 v{latestWorkspace.version}<br/>flomo 检查于 {date(latestWorkspace.lastCheckedAt, true)}</p></div></details></div>
        <GoalEditor workspace={latestWorkspace} onUpdate={update} onDirty={(dirty) => { goalDirty.current = dirty; }} />
      </section>
      <nav className="work-tabs" aria-label="当前工作视图">{(["note", "materials", "discussion", "writing", "draft"] as WorkbenchView[]).map((item) => <button key={item} className={view === item ? "selected" : ""} aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>{item === "note" ? <FileText size={16}/> : item === "materials" ? <Layers3 size={16}/> : item === "discussion" ? <MessageCircle size={16}/> : item === "writing" ? <Sparkles size={16}/> : <BookOpen size={16}/>}<span>{viewLabels[item]}</span>{item === "materials" && (selectedCount > 0 || proposed.length > 0) && <span className="tab-count" title={`已选 ${selectedCount} 条，待选 ${proposed.length} 条`}>{proposed.length ? `${proposed.length} 待选` : selectedCount}</span>}{item === "note" && decisionsToReview.length > 0 && <span className="tab-dot"/>}{item === "draft" && (editor.review || editor.conflict) && <span className="tab-dot"/>}</button>)}</nav>
      <div className="work-view">
        <ErrorBox error={error}/>
        {editor.review && <div className="notice update-notice" role="status"><strong>Codex / 另一端更新了草稿</strong><p>{latestRevision?.actor !== "web" && latestRevision?.summary ? latestRevision.summary : "当前阅读和输入保持不变，查看后再采用新版本。"}</p><button className="text-button" onClick={() => setReviewOpen(true)}>查看草稿变化<ArrowRight size={14}/></button></div>}
        {editor.conflict && <div className="notice conflict-notice" role="alert"><strong>另一端更新了草稿，你的输入已保留</strong><p>两份内容都在。比较后选择要保留的版本。</p><button className="text-button" onClick={() => setReviewOpen(true)}>比较并处理<ArrowRight size={14}/></button></div>}
        {latestWorkspace.sourceChanged && <div className="notice remote-notice"><div><strong>flomo 原笔记有新内容</strong><p>本地草稿已保留，写回前需要比较。</p></div><button className="text-button" onClick={() => setRemoteCompare(true)}>比较原文变化<ArrowRight size={14}/></button></div>}
        {activeJobs.length > 0 && <JobList jobs={activeJobs} onAbandon={setAbandonJob} onReconcile={(id) => void action("reconcile", async () => { await api.reconcile(id); await jobs.refetch(); void client.invalidateQueries({ queryKey: ["workspace", workspace.id] }); })}/>}
        {view !== "materials" && pendingLinks.length > 0 && <div className="notice" role="status"><strong>{pendingLinks.some(job => job.status === "uncertain") ? "笔记关联结果待核对" : "正在建立笔记关联"}</strong><button className="text-button" onClick={() => onView("materials")}>查看关联记录<ArrowRight size={13}/></button></div>}
        <div className="note-view" hidden={view !== "note"}>
          <section className="decision-section" hidden={!pendingDecisions.length && ![...dirtyInputs].some(key => key.startsWith("decision:"))}><div className="section-heading"><h2>需要你判断 <span>{decisionsToReview.length}</span></h2></div><p className="section-description">选择会保留在工作区，Codex 可以接着处理。</p>{decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} disabled={!!busy} onDirty={(dirty) => trackInput(`decision:${decision.id}`, dirty)} onAnswer={async (answer, expectedAnswer) => { const saved = await editor.session.flush(); if (saved.decisions?.find(item => item.id === decision.id)?.answer !== expectedAnswer) throw new Error("这条判断已被另一端更新，请先核对新答案。"); update(await api.answerDecision(workspace.id, decision.id, answer, saved.version)); }}/>)}</section>
          <section className="reading-surface" aria-label="flomo 原文">
            <div className="document-label"><FileText size={13}/><span>flomo 原文</span></div>
            <article className="source-document"><Markdown>{workspace.source.content}</Markdown>{workspace.source.content_truncated && <div className="notice">原文不完整，请检查接入状态后重新读取。</div>}</article>
          </section>
          <LinkedMemos workspace={latestWorkspace} active={view === "note"} disabled={!!busy || !!editor.review || !!editor.conflict} onSelect={selectLinkedMemo} renderContent={content => <Markdown>{content}</Markdown>}/>
          {sourceAssociations("source")}
          <div className="supporting-tools">
          <AnnotationComposer workspace={workspace} jobs={jobs.data ?? []} onDirty={(dirty) => trackInput("annotation", dirty)} onCreated={() => void jobs.refetch()}/>
          <div className="next-step"><button className="text-button" onClick={() => onView("materials")}><Layers3 size={15}/>查看相关材料<ArrowRight size={14}/></button>{selectedCount > 0 && <span>已选 {selectedCount} 条</span>}</div>
          {decisions.some((item) => item.answer) && <details className="quiet-disclosure"><summary>已作出的判断 <span>{decisions.filter((item) => item.answer).length}</span></summary>{decisions.filter((item) => item.answer).map((item) => <div key={item.id} className="answered-decision"><strong>{item.question}</strong><p>{item.answer}</p><span>{date(item.answeredAt ?? undefined, true)} · 已共享给 Codex</span></div>)}</details>}
          <div className="next-step"><button className="text-button" onClick={() => onView("discussion")}><MessageCircle size={15}/>讨论与补充<ArrowRight size={14}/></button><span>结合已选材料，继续推敲想法</span></div>
          </div>
        </div>
        <div className="materials-view" hidden={view !== "materials"}>
          <div className="materials-heading"><div><h2>关联材料</h2><p>发现旧笔记之间的联系，留下值得继续思考的内容。</p></div><button className="text-button subdued" onClick={() => setMaterialSearch(true)}><Search size={14}/>手动查找</button></div>
          <details className="discovery-drawer" open={discoveryOpen} onToggle={event => setDiscoveryOpen(event.currentTarget.open)}>
            <summary><span className="discovery-drawer-icon">{discoveryRunning ? <Loader2 size={17} className="spin"/> : <Sparkles size={17}/>}</span><span className="discovery-drawer-label"><strong>{discoveryRunning ? "AI 正在查找材料" : candidates.length || selectedCount ? "继续找材料" : "让 AI 帮你找材料"}</strong><span>{discoveryNotice || (discoveryRunning ? "完成后推荐会自动出现在下方" : latestDiscovery?.status === "failed" ? "上次查找未完成，展开查看" : dirtyInputs.has("discovery") ? "有尚未提交的查找方向，展开继续" : latestDiscovery?.discovery?.result ? `上次读了 ${latestDiscovery.discovery.result.readCount} 条笔记 · 查看记录或调整方向` : "根据当前笔记寻找关联，也可以指定方向")}</span></span><ChevronDown size={15} className="discovery-drawer-chevron"/></summary>
          <TopicDiscovery onStatus={setDiscoveryNotice} workspace={latestWorkspace} jobs={jobs.data ?? []} aiConfigured={aiConfigured} disabled={!!busy || !!editor.review || !!editor.conflict} flush={() => { if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑后再找材料。"); return editor.session.flush(); }} onUpdate={update} onDirty={(dirty) => trackInput("discovery", dirty)}/>
          </details>
          <nav className="material-filters" aria-label="材料状态">
            <button className={materialFilter === "proposed" ? "selected" : ""} aria-pressed={materialFilter === "proposed"} onClick={() => setMaterialFilter("proposed")}>待你选择 <span>{proposed.length}</span></button>
            <button className={materialFilter === "selected" ? "selected" : ""} aria-pressed={materialFilter === "selected"} onClick={() => setMaterialFilter("selected")}>已选用 <span>{selectedCount}</span></button>
            <button className={materialFilter === "dismissed" ? "selected" : ""} aria-pressed={materialFilter === "dismissed"} onClick={() => setMaterialFilter("dismissed")}>暂时不用 <span>{dismissed.length}</span></button>
          </nav>
          <section className="candidate-section" hidden={materialFilter !== "proposed"} aria-label="待你选择的材料">{proposed.length ? proposed.map((item) => materialCard(item.memo, item)) : <div className="empty-state small-empty"><CheckCheck size={24}/><h3>{selectedCount || dismissed.length ? "这轮材料已看完" : "还没有待选材料"}</h3><p>{selectedCount || dismissed.length ? "可以查看已选用的材料，或展开上方继续查找。" : "展开上方，让 AI 推荐相关笔记，也可以手动查找。"}</p></div>}</section>
          <section hidden={materialFilter !== "selected"} aria-label="已选用的材料">{selectedCount ? <><div className="selection-summary"><span>{selectedCount} 条材料将用于讨论和写作</span><button className="text-button" onClick={() => onView("discussion")}>结合材料讨论<ArrowRight size={13}/></button></div>{selected.map((memo) => materialCard(memo, candidates.find((item) => item.memo.id === memo.id)))}{collectorMaterials.map((material) => <CollectorMaterialCard key={material.article.id} material={material} disabled={!!busy} configured={collectorConfigured} onRefresh={attachSource} onRemove={removeSource} renderContent={(content) => <Markdown>{content}</Markdown>}/>)}</> : <div className="empty-state small-empty"><Layers3 size={24}/><h3>还没有选用材料</h3><p>在「待你选择」中阅读关联理由和原文，再选用需要的内容。</p><button className="text-button" onClick={() => setMaterialFilter("proposed")}>查看推荐<ArrowRight size={14}/></button></div>}</section>
          <section hidden={materialFilter !== "dismissed"} aria-label="暂时不用的材料">{dismissed.length ? dismissed.map((item) => materialCard(item.memo, item)) : <div className="empty-state small-empty"><h3>还没有暂时不用的材料</h3><p>略过的推荐会留在这里，之后仍可以选用。</p></div>}</section>
          <NoteLinksPanel workspace={latestWorkspace} jobs={linkJobs.data ?? []} onOpen={target => setLinkDialog({target})} onUpdate={update}/>
          <ErrorBox error={linkJobs.error} retry={() => void linkJobs.refetch()}/>
          <details className="quiet-disclosure material-sources-disclosure"><summary><Link2 size={14}/>查找链接对应的收藏原文</summary>{sourceAssociations("all")}</details>
        </div>
        <div className="discussion-view" hidden={view !== "discussion"}>
          <DiscussionPanel workspace={latestWorkspace} aiConfigured={aiConfigured} disabled={!!busy || !!editor.review || !!editor.conflict}
            onNewDraft={createNoteDraft} onDirty={(dirty) => trackInput("chat", dirty)} onUpdate={update} onApply={applyToSource}
            onMaterials={() => { setMaterialFilter("selected"); onView("materials"); }} renderContent={(content) => <Markdown>{content}</Markdown>}
            flush={() => { if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑后再讨论。"); return editor.session.flush(); }}
            onRefreshMaterials={async () => {
              if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑。");
              const saved = await editor.session.flush();
              const refreshed = await api.refreshDiscussion(workspace.id, saved.version);
              update(refreshed); return refreshed;
            }}/>
        </div>
        <div className="writing-view" hidden={view !== "writing"}>
          <AnalysisPanel onNewDraft={createNoteDraft} onOpenCard={(analysisId,cardId)=>{setDraftChoice(`card:${analysisId}:${cardId}`);onView("draft");}} onMaterials={() => onView("materials")} workspace={latestWorkspace} aiConfigured={aiConfigured} disabled={!!busy || !!editor.review || !!editor.conflict} flush={() => { if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑后再分析。"); return editor.session.flush(); }} onUpdate={update} onDirty={(dirty) => trackInput("analysis", dirty)} renderContent={(content) => <Markdown>{content}</Markdown>} onApply={applyToSource}/>
        </div>
        <div className="draft-view" hidden={view !== "draft"}>
          <section className="draft-collection" aria-label="本次笔记与草稿">
            <div className="section-heading"><div><h2>本次笔记</h2><p className="section-description">在原笔记上继续写，也可以从它出发写成多篇新笔记。</p></div><button className="button secondary small" disabled={!!busy || !!editor.review || !!editor.conflict} onClick={()=>void createNoteDraft().catch(()=>{})}><Plus size={14}/>新笔记草稿</button></div>
            <nav className="draft-library" aria-label="选择要编辑的笔记">
              <button className={`draft-library-item ${activeDraftChoice === 'source' ? 'selected' : ''}`} aria-current={activeDraftChoice === 'source' ? 'true' : undefined} onClick={()=>setDraftChoice('source')}><FileText size={15}/><span><strong>当前笔记</strong><small>{excerpt(workspace.title,100)}</small></span><em>{editor.dirty ? '未保存' : '写回原笔记'}</em></button>
              {noteDrafts.map(draft=><button key={draft.id} className={`draft-library-item ${activeDraftChoice === `note:${draft.id}` ? 'selected' : ''}`} aria-current={activeDraftChoice === `note:${draft.id}` ? 'true' : undefined} onClick={()=>setDraftChoice(`note:${draft.id}`)}><BookOpen size={15}/><span><strong>{draft.title || '未命名的新笔记'}</strong><small>从当前笔记延伸</small></span><em>{dirtyInputs.has(`note-draft:${draft.id}`) ? '未保存' : ({draft:'新草稿',publishing:'创建中',published:'已创建',uncertain:'待核对',failed:'未创建'}[draft.status])}</em></button>)}
              {cardDrafts.map(({record,card,key})=><button key={key} className={`draft-library-item ${activeDraftChoice === key ? 'selected' : ''}`} aria-current={activeDraftChoice === key ? 'true' : undefined} onClick={()=>setDraftChoice(key)}><Layers3 size={15}/><span><strong>{card.title}</strong><small>由分析提炼的卡片</small></span><em>{dirtyInputs.has(key) ? '未保存' : ({draft:'候选卡片',publishing:'创建中',published:'已创建',uncertain:'待核对',failed:'未创建'}[card.status])}</em></button>)}
              {createdAnnotations.map(job=><button key={job.id} className={`draft-library-item ${activeDraftChoice === `annotation:${job.id}` ? 'selected' : ''}`} aria-current={activeDraftChoice === `annotation:${job.id}` ? 'true' : undefined} onClick={()=>setDraftChoice(`annotation:${job.id}`)}><MessageCircle size={15}/><span><strong>{excerpt(job.resultMemo!.content,80)}</strong><small>基于当前笔记的批注</small></span><em>{job.status === 'succeeded' ? '已创建' : '待核对'}</em></button>)}
            </nav>
            {!noteDrafts.length && !cardDrafts.length && <p className="scope-notice">还没有新笔记草稿。点击“新笔记草稿”，或将写作结果另存为新笔记。</p>}
          </section>
          <div hidden={activeDraftChoice !== 'source'} className="source-draft-editor"><div className="draft-target-heading"><h3>当前笔记的草稿</h3><span>确认写回后更新原笔记</span></div><div className="editor-toolbar"><button className="text-button" onClick={() => onView("writing")}><Sparkles size={14}/>前往写作</button><div className="segmented"><button className={!preview ? "selected" : ""} onClick={() => setPreview(false)}>编辑</button><button className={preview ? "selected" : ""} onClick={() => setPreview(true)}>阅读</button></div></div>
          <ErrorBox error={editor.error} retry={editor.error ? () => void editor.session.flush().catch(() => {}) : undefined}/>
          {preview ? <div className="draft-preview"><Markdown>{editor.draft || "草稿还没有内容。"}</Markdown></div> : <textarea className="draft-editor" aria-label="工作草稿" value={editor.draft} onChange={(event) => editor.session.edit(event.target.value)} spellCheck={false} placeholder="写下自己的判断，或让 Codex 把讨论结果整理到这里。"/>}
          <div className="editor-footer"><span>{editor.draft.length.toLocaleString()} 字符 · Markdown</span></div>
          <details className="quiet-disclosure revision-history"><summary><Clock3 size={15}/>草稿修改记录 <span>{revisions.data?.length ?? 0}</span></summary><ErrorBox error={revisions.error} retry={() => void revisions.refetch()}/>{revisions.data?.length ? revisions.data.map((revision) => <button className="revision-row" key={revision.id} onClick={() => setRevisionOpen(revision)}><span><strong>{revision.summary || "更新了草稿"}</strong><small>{revision.actor === "web" ? "你在工作台" : "Codex / 外部助手"} · {date(revision.createdAt, true)} · v{revision.toVersion}</small></span><ArrowRight size={14}/></button>) : <p className="scope-notice">草稿修改后，会在这里保留版本和具体变化。</p>}</details>
          </div>
          {noteDrafts.map(draft=><div key={draft.id} hidden={activeDraftChoice !== `note:${draft.id}`}><NoteDraftEditor workspace={latestWorkspace} draft={draft} disabled={!!busy || !!editor.review || !!editor.conflict} flush={()=>editor.session.flush()} onUpdate={update} onDirty={dirty=>trackInput(`note-draft:${draft.id}`,dirty)} renderContent={content=><Markdown>{content}</Markdown>}/></div>)}
          {cardDrafts.map(({record,card,key})=><div key={key} hidden={activeDraftChoice !== key}><AnalysisCardDraft workspace={latestWorkspace} record={record} card={card} disabled={!!busy || !!editor.review || !!editor.conflict} flush={()=>editor.session.flush()} onUpdate={update} onDirty={dirty=>trackInput(key,dirty)} renderContent={content=><Markdown>{content}</Markdown>}/></div>)}
          {createdAnnotations.map(job=><section key={job.id} hidden={activeDraftChoice !== `annotation:${job.id}`} className="note-draft-editor"><div className="section-heading"><h3>已创建的批注笔记</h3><MemoLink memo={job.resultMemo!}>在 flomo 查看</MemoLink></div><div className="draft-preview"><Markdown>{job.resultMemo!.content}</Markdown></div></section>)}
        </div>
        {historyJobs.length > 0 && <details className="quiet-disclosure task-history"><summary>已完成和失败的任务</summary><JobList jobs={historyJobs} onAbandon={setAbandonJob} onReconcile={() => {}}/></details>}
        <ErrorBox error={jobs.error} retry={() => void jobs.refetch()}/>
      </div>
      {linkDialog && <NoteLinkDialog workspace={latestWorkspace} target={linkDialog.target} flush={() => editor.session.flush()} onUpdate={update} onClose={() => setLinkDialog(null)}/>}
      {view === "draft" && activeDraftChoice === "source" && <footer className="draft-actionbar"><div><strong className={editor.error ? "error" : ""}>{editor.saving ? <Loader2 size={13} className="spin"/> : !editor.dirty && !editor.review && !editor.conflict ? <CheckCheck size={14}/> : <Circle size={8}/>} {saveStatus}</strong><span>确认写回后才会更新 flomo</span></div><button className="button primary" disabled={!!busy || !!editor.conflict || !!editor.review || activeJobs.some((job) => job.kind === "publish")} onClick={() => void preparePublish()}>{busy === "preview" ? <Loader2 size={14} className="spin"/> : <ArrowUpRight size={15}/>}预览写回</button></footer>}
      {reviewOpen && (editor.review || editor.conflict) && <Modal title={editor.conflict ? "选择要继续的草稿" : "查看另一端的草稿更新"} wide onClose={() => setReviewOpen(false)}><p className="modal-description">{editor.conflict ? "删除标记对应你的当前输入，新增标记对应另一端内容。你的输入仍保留在编辑器中，可关闭此窗口手动合并。" : "这里显示从当前草稿到新版本的变化；采用后才会更新编辑区。"}</p><InlineDiff before={editor.draft} after={(editor.conflict ?? editor.review)!.draft}/><div className="modal-actions"><button className="button secondary" onClick={() => setReviewOpen(false)}>暂不处理</button>{editor.conflict ? <><button className="button secondary" onClick={() => { editor.session.resolve("local"); setReviewOpen(false); }}>保留我的输入并保存</button><button className="button primary" onClick={() => { editor.session.resolve("server"); setReviewOpen(false); onView("draft"); }}>采用另一端版本</button></> : <button className="button primary" onClick={() => { editor.session.acceptReview(); setReviewOpen(false); onView("draft"); }}>采用新版本</button>}</div></Modal>}
      {revisionOpen && <Modal title={restoreTarget ? `还原到 v${restoreTarget.version}` : "草稿改动"} wide onClose={() => { if (!busy) {setRevisionOpen(null); setRestoreTarget(null);} }}>
        {restoreTarget ? <><p className="modal-description">以下比较当前草稿与目标版本。确认后会先保存当前编辑，再将旧版内容保存为新的修改记录；不会写回 flomo。</p><InlineDiff before={editor.draft} after={restoreTarget.content}/><ErrorBox error={error}/><div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={() => setRestoreTarget(null)}>返回版本记录</button><button className="button primary" disabled={!!busy || !!editor.review || !!editor.conflict} onClick={() => void action("restore", async () => {await editor.session.flush(); editor.session.edit(restoreTarget.content); await editor.session.flush(); await revisions.refetch(); setRevisionOpen(null); setRestoreTarget(null); onView("draft");})}>{busy === "restore" ? "正在还原…" : "确认还原"}</button></div>{(editor.review || editor.conflict) && <p className="notice">请先关闭窗口，处理另一端的草稿更新，再还原。</p>}</> : <><p className="modal-description">{revisionOpen.summary || "更新草稿"} · {date(revisionOpen.createdAt, true)} · v{revisionOpen.fromVersion} → v{revisionOpen.toVersion}</p><InlineDiff before={revisionOpen.before} after={revisionOpen.after}/><div className="modal-actions"><button className="button secondary" onClick={() => {setError(""); setRestoreTarget({version:revisionOpen.fromVersion,content:revisionOpen.before});}}>还原到修改前 v{revisionOpen.fromVersion}</button><button className="button primary" onClick={() => {setError(""); setRestoreTarget({version:revisionOpen.toVersion,content:revisionOpen.after});}}>还原到此版本 v{revisionOpen.toVersion}</button></div></>}
      </Modal>}
      {abandonJob && (
        <Modal title="结束不确定写回的跟踪" onClose={() => setAbandonJob(null)}>
          <p className="modal-description">
            仅在你已经打开 flomo
            人工核对内容后继续。原请求仍可能延迟完成，重新写回前请刷新比较。
          </p>
          <MemoLink memo={workspace.source}>打开 flomo 核对原笔记</MemoLink>
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setAbandonJob(null)}
            >
              继续跟踪
            </button>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() =>
                void action("abandon", async () => {
                  const saved = await editor.session.flush();
                  await api.abandon(abandonJob, saved.version);
                  await jobs.refetch();
                  setAbandonJob(null);
                })
              }
            >
              已人工核对，结束本次跟踪
            </button>
          </div>
        </Modal>
      )}
      {materialSearch && (
        <MaterialDialog
          selected={latestWorkspace.materials.map((memo) => memo.id)}
          sourceId={workspace.memoId}
          onClose={() => setMaterialSearch(false)}
          onAdd={async (ids) => {
            const saved = await editor.session.flush();
            update(
              await api.materials(
                workspace.id,
                Array.from(
                  new Set([...saved.materials.map((memo) => memo.id), ...ids]),
                ),
                saved.version,
              ),
            );
            setMaterialSearch(false);
          }}
        />
      )}
      {remoteCompare && (
        <Modal
          title="flomo 原笔记发生了变化"
          wide
          onClose={() => setRemoteCompare(false)}
        >
          <p className="modal-description">
            比较完成后，可以将远端新内容设为比较基准。本地草稿会保留；需要的内容可手动合并到草稿。
          </p>
          <InlineDiff before={workspace.source.content} after={latestWorkspace.remote?.content ?? "请重新检查远端内容"} />
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setRemoteCompare(false)}
            >
              继续编辑草稿
            </button>
            <button
              className="button primary"
              disabled={!!busy || !latestWorkspace.remote || !!editor.conflict}
              onClick={() =>
                void action("rebase", async () => {
                  const saved = await editor.session.flush();
                  update(await api.rebase(workspace.id, saved.version));
                  setRemoteCompare(false);
                })
              }
            >
              已比较，更新基准并保留草稿
            </button>
          </div>
        </Modal>
      )}
      {publishPreview && (
        <Modal
          title="确认写回 flomo"
          wide
          onClose={() => {
            if (busy !== "publish") setPublishPreview(null);
          }}
        >
          <p className="modal-description">
            以下草稿将更新来源笔记。原始标签由草稿中的标签决定，请确认内容和来源链接后再写回。
          </p>
          <div className="publish-target">
            <Link2 size={15} />
            <MemoLink memo={publishPreview.source}>
              查看即将更新的 flomo 笔记
            </MemoLink>
            <span>草稿版本 v{publishPreview.version}</span>
          </div>
          <InlineDiff before={publishPreview.source.content} after={publishPreview.draft} />
          {publishPreview.sourceChanged && (
            <div className="notice">
              flomo 原文已改变，请先关闭预览，比较远端变化并更新基准。
            </div>
          )}
          {latestWorkspace.version !== publishPreview.version && (
            <div className="notice">
              工作区已更新，请关闭后重新预览最新版本。
            </div>
          )}
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={busy === "publish"}
              onClick={() => setPublishPreview(null)}
            >
              继续编辑
            </button>
            <button
              className="button primary"
              disabled={
                !!busy ||
                publishPreview.sourceChanged ||
                latestWorkspace.version !== publishPreview.version ||
                !publishPreview.draft.trim()
              }
              onClick={() => void publish()}
            >
              {busy === "publish" ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <ArrowUpRight size={15} />
              )}
              确认写回 flomo
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

const relationLabels = { support: "支持观点", counterpoint: "不同角度", example: "实际案例", background: "背景资料" };

function GoalEditor({ workspace, onUpdate, onDirty }: { workspace: Workspace; onUpdate: (workspace: Workspace) => void; onDirty: (dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(workspace.goal ?? "");
  const [base, setBase] = useState({ goal: workspace.goal ?? "", version: workspace.version });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = editing && value !== base.goal;
  const remotelyChanged = editing && (workspace.goal ?? "") !== base.goal;
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => {
    if (!editing) { setValue(workspace.goal ?? ""); setBase({ goal: workspace.goal ?? "", version: workspace.version }); }
  }, [workspace.goal, workspace.version, editing]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function save() {
    setBusy(true); setError("");
    try {
      // Editing is based on the goal the user actually saw. Other workspace changes
      // may advance the version, but a new remote goal must be explicitly reviewed.
      if (remotelyChanged) throw new Error("另一端修改了本次目标，请先核对下面的新目标。");
      const saved = await api.goal(workspace.id, value.trim(), workspace.version);
      onUpdate(saved); setEditing(false); onDirty(false);
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  if (!editing && !workspace.goal) return <button className="goal-empty" onClick={() => { setValue(""); setBase({ goal: "", version: workspace.version }); setEditing(true); }}><Plus size={14}/>添加本次目标</button>;
  return <section className={`goal-card ${editing ? "editing" : ""}`}>
    <div className="goal-label"><span>本次目标</span>{!editing && <button className="text-button" onClick={() => { setValue(workspace.goal ?? ""); setBase({ goal: workspace.goal ?? "", version: workspace.version }); setEditing(true); }}>{workspace.goal ? "修改" : "设定目标"}</button>}</div>
    {editing ? <><textarea aria-label="本次加工目标" readOnly={busy} autoFocus rows={3} value={value} placeholder="例如：明确这个账号服务谁、解决什么问题，以及先做什么内容。" onChange={(event) => setValue(event.target.value)} maxLength={5000}/>{remotelyChanged && <div className="notice"><strong>另一端的新目标</strong><p>{workspace.goal || "（已清空）"}</p><button className="text-button" onClick={() => { setValue(workspace.goal ?? ""); setBase({ goal: workspace.goal ?? "", version: workspace.version }); setError(""); }}>采用新目标</button><button className="text-button" onClick={() => { setBase({ goal: workspace.goal ?? "", version: workspace.version }); setError(""); }}>已核对，继续用我的输入</button></div>}<ErrorBox error={error}/><div className="inline-actions"><button className="text-button subdued" disabled={busy} onClick={() => { setEditing(false); setError(""); onDirty(false); }}>取消</button><button className="button primary small" disabled={busy || remotelyChanged} onClick={() => void save()}>{busy ? "保存中…" : "保存目标"}</button></div></> : <p className={workspace.goal ? "" : "placeholder-text"}>{workspace.goal || "让 Codex 知道你想完善什么：一个观点、一篇文章，或下一步行动。"}</p>}
  </section>;
}

function DecisionCard({ decision, disabled, onAnswer, onDirty }: {
  decision: Decision; disabled: boolean;
  onAnswer: (answer: string, expectedAnswer: string | null) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [baseAnswer, setBaseAnswer] = useState(decision.answer);
  const [custom, setCustom] = useState(!decision.options.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = !!answer.length;
  const remotelyChanged = dirty && decision.answer !== baseAnswer;
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy]);
  useEffect(() => { if (!dirty && !busy) setBaseAnswer(decision.answer); }, [decision.answer, dirty, busy]);
  async function submit(value: string) {
    if (!value.trim() || busy || remotelyChanged) return;
    setBusy(true); setError("");
    try { await onAnswer(value.trim(), baseAnswer); setAnswer(""); }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  if (decision.answer && !dirty && !busy) return null;
  return <article className="decision-card">
    <h3>{decision.question}</h3>
    {remotelyChanged && <div className="notice"><strong>另一端已回答，你的输入已保留</strong><p>{decision.answer}</p>
      <div className="inline-actions"><button className="text-button" onClick={() => { setAnswer(""); setBaseAnswer(decision.answer); setError(""); }}>采用这个回答</button><button className="text-button" onClick={() => { setBaseAnswer(decision.answer); setError(""); }}>已核对，继续用我的输入</button></div>
    </div>}
    <div className="decision-options">{decision.options.map((option) => <button key={option} className="decision-option" disabled={disabled || busy || remotelyChanged} onClick={() => void submit(option)}>{option}<ArrowRight size={14}/></button>)}</div>
    {!custom ? <button className="text-button subdued" onClick={() => setCustom(true)}>补充自己的回答</button> : <div className="decision-answer">
      <textarea aria-label={`回答：${decision.question}`} rows={2} value={answer} readOnly={busy} maxLength={5000} onChange={(event) => setAnswer(event.target.value)} placeholder="写下你的判断或约束…"/>
      <button className="button secondary small" disabled={disabled || busy || remotelyChanged || !answer.trim()} onClick={() => void submit(answer)}>{busy ? "保存中…" : "保存判断"}</button>
    </div>}
    <ErrorBox error={error}/>
  </article>;
}

function JobList({
  jobs,
  onReconcile,
  onAbandon,
}: {
  jobs: Job[];
  onReconcile: (id: string) => void;
  onAbandon: (id: string) => void;
}) {
  if (!jobs.length) return null;
  const active = jobs.filter(
    (job) => job.status === "running" || job.status === "uncertain",
  );
  const visible = [
    ...active,
    ...jobs
      .filter((job) => !active.some((item) => item.id === job.id))
      .slice(0, 5),
  ];
  return (
    <div className="job-list">
      <h4>
        <Clock3 size={13} />
        最近任务
      </h4>
      {visible.map((job) => (
        <div className={`job-item ${job.status}`} key={job.id}>
          <div>
            {job.status === "running" ? (
              <Loader2 size={13} className="spin" />
            ) : job.status === "succeeded" ? (
              <Check size={13} />
            ) : (
              <Circle size={10} />
            )}
            <strong>{job.kind === "publish" ? "写回 flomo" : job.kind === "annotation" ? "新建批注" : job.kind === "discovery" ? "AI 找材料" : "AI 讨论"}</strong>
            <span>
              {
                {
                  running: "进行中",
                  succeeded: "已完成",
                  failed: "失败",
                  uncertain: "结果待核实",
                }[job.status]
              }
            </span>
          </div>
          {job.error && <p>{job.error}</p>}
          {job.status === "running" && job.kind === "ai" && job.text && (
            <pre className="streaming-text">{job.text}</pre>
          )}
          {job.resultMemo && <MemoLink memo={job.resultMemo}>打开批注笔记</MemoLink>}
          {job.status === "uncertain" && job.kind === "publish" && (
            <>
              <p>请求结果不明确。先核实远端状态，避免重复写回。</p>
              <button
                className="text-button"
                onClick={() => onReconcile(job.id)}
              >
                核实 flomo 写回结果
              </button>
              <button
                className="text-button manual-recovery"
                onClick={() => onAbandon(job.id)}
              >
                人工核对后结束跟踪
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function AnnotationComposer({ workspace, jobs, onDirty, onCreated }: {workspace:Workspace; jobs:Job[]; onDirty:(dirty:boolean)=>void; onCreated:()=>void}) {
  const storageKey = `flomo-annotation:${workspace.id}`;
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [key, setKey] = useState(() => localStorage.getItem(`${storageKey}:request`) ?? randomUUID());
  const [submitted, setSubmitted] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = jobs.find(job => job.kind === "annotation" && job.idempotencyKey === key) ?? submitted;
  const annotations = jobs.filter(job => job.kind === "annotation");
  useEffect(() => { localStorage.setItem(storageKey, content); localStorage.setItem(`${storageKey}:request`, key); onDirty(!!content.trim() && !current); }, [content, key, current?.id]);
  return <section className="annotation-section">
    <button className="text-button" onClick={() => setOpen(!open)}><MessageCircle size={15}/>{open ? "收起批注" : "写批注"}</button>
    {open && <div className="annotation-composer">
      <p className="scope-notice">写下自己的想法，创建一条新的 flomo 笔记，并自动双链到当前原笔记。可在正文添加 #想法 等标签。</p>
      <textarea aria-label="批注内容" value={content} disabled={busy || !!current} onChange={event => setContent(event.target.value)} placeholder="这条笔记让我想到……"/>
      <p className="scope-notice">关联原笔记：<MemoLink memo={workspace.source}>{excerpt(workspace.title, 200)}</MemoLink></p>
      <ErrorBox error={error}/>
      {!current && <button className="button primary" disabled={busy || !content.trim()} onClick={() => { setBusy(true); setError(""); void api.annotate(workspace.id, content, key).then(job => {setSubmitted(job); onCreated();}).catch(error => setError(messageOf(error))).finally(() => setBusy(false)); }}>{busy ? "正在提交…" : "创建批注笔记"}</button>}
      {current && <p role="status">{current.status === "running" ? "正在创建批注…" : current.status === "succeeded" ? "已创建批注并关联原笔记" : current.error}</p>}
      {current?.status === "succeeded" && <button className="text-button" onClick={() => {setContent(""); setKey(randomUUID()); setSubmitted(null);}}>再写一条批注</button>}
    </div>}
    {annotations.map(job => <div className="annotation-record" key={job.id}><span>{date(job.createdAt,true)} · {job.status === "succeeded" ? "已创建" : job.status === "running" ? "创建中" : "待核实"}</span>{job.resultMemo && <MemoLink memo={job.resultMemo}>打开批注笔记</MemoLink>}{job.error && <p>{job.error}</p>}</div>)}
  </section>;
}

function MaterialDialog({
  selected,
  sourceId,
  onAdd,
  onClose,
}: {
  selected: string[];
  sourceId: string;
  onAdd: (ids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useSavedFilter<string>("materials.query", "");
  const [tag, setTag] = useSavedFilter<string>("materials.tag", "");
  const [excludeTag, setExcludeTag] = useSavedFilter<string>("materials.excludeTag", "");
  const excluded = useDebounce(excludeTag.trim().replace(/^#/, ""));
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useDebounce(query);
  const isRelated = !search.trim() && !tag && !excluded;
  const memos = useQuery({
    queryKey: ["material-search", sourceId, search, tag, excluded],
    queryFn: () =>
      isRelated
        ? api
            .related(sourceId)
            .then((memos) => ({ memos, limit: 30, possiblyLimited: false }))
        : api.memos({ q: search, tag, excludeTag: excluded, limit: "30" }),
  });
  return (
    <Modal title="为这次思考找一些材料" wide onClose={onClose}>
      <div className="material-search-tools">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索参考材料"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="关键词、观点或一个问题…"
          />
        </label>
        <select
          aria-label="材料标签"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        >
          <option value="">全部标签</option>
          {(settings.data?.pinnedTags ?? pinnedTags).map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
      <label className="material-exclusion">
        <span>不包含标签</span>
        <input aria-label="排除材料标签" list="material-excluded-tags" value={excludeTag} onChange={(event) => { setExcludeTag(event.target.value); setChecked([]); }} placeholder="输入标签，如：概要" />
        <datalist id="material-excluded-tags">{(settings.data?.pinnedTags ?? pinnedTags).map(item => <option key={item} value={item} />)}</datalist>
        <small>同时排除该标签的子标签；留空则不排除。</small>
      </label>
      <ErrorBox
        error={error || memos.error}
        retry={memos.isError ? () => void memos.refetch() : undefined}
      />
      <div className="scope-notice">
        {isRelated
          ? "根据来源笔记推荐关联材料；勾选后才会加入上下文。"
          : "按关键词和标签查找材料。"}
      </div>
      <div className="material-results">
        {memos.isPending ? (
          <Loading />
        ) : memos.data?.memos.length === 0 ? (
          <div className="empty-state">本次返回结果中没有符合条件的材料，可调整筛选后重试。</div>
        ) : (
          memos.data?.memos.map((memo) => {
            const already = selected.includes(memo.id) || memo.id === sourceId;
            return (
              <label
                className={`material-result ${already ? "disabled" : ""}`}
                key={memo.id}
              >
                <input
                  type="checkbox"
                  checked={already || checked.includes(memo.id)}
                  disabled={
                    already ||
                    (checked.length + selected.length >= 30 &&
                      !checked.includes(memo.id))
                  }
                  onChange={(event) =>
                    setChecked(
                      event.target.checked
                        ? [...checked, memo.id]
                        : checked.filter((id) => id !== memo.id),
                    )
                  }
                />
                <span>
                  <span className="material-result-meta">
                    {date(memo.created_at)} {already ? "· 已在上下文中" : ""}
                  </span>
                  <span className="material-result-text">
                    {excerpt(memo.content, 300)}
                  </span>
                  <span className="memo-tags">
                    {memo.tags.slice(0, 4).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
      {memos.data?.possiblyLimited && (
        <div className="scope-notice">
          {excluded ? "已从本次返回的候选中排除指定标签，可能还有未返回的匹配笔记。可添加关键词或包含标签缩小范围。" : `仅展示本次搜索的前 ${memos.data.limit} 条结果，可缩小关键词范围。`}
        </div>
      )}
      <div className="modal-actions">
        <span className="muted">
          已选择 {checked.length} 条 · 最多 30 条材料
        </span>
        <button
          className="button primary"
          disabled={busy || checked.length === 0}
          onClick={() => {
            setBusy(true);
            setError("");
            void onAdd(checked)
              .catch((error) => setError(messageOf(error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={15} />}
          添加到工作区
        </button>
      </div>
    </Modal>
  );
}

function SettingsDialog({
  settings,
  aiConfigured,
  flomoConfigured,
  onClose,
}: {
  settings?: Settings;
  aiConfigured: boolean;
  flomoConfigured: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [tags, setTags] = useState(
    (settings?.pinnedTags ?? pinnedTags).join("\n"),
  );
  const [refreshSeconds, setRefreshSeconds] = useState(
    settings?.refreshSeconds ?? 0,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="工作台设置" onClose={onClose}>
      <div className="settings-form">
        <label>
          置顶标签<span>每行一个，按此顺序展示；筛选包含子标签。</span>
          <textarea
            aria-label="置顶标签"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            rows={6}
          />
        </label>
        <label>
          检查工作区原笔记的 flomo 更新
          <span>只检查已保存工作区关联的笔记，不代表全库同步。</span>
          <select
            aria-label="自动检查间隔"
            value={refreshSeconds}
            onChange={(event) => setRefreshSeconds(Number(event.target.value))}
          >
            <option value={0}>仅手动检查</option>
            <option value={60}>每 1 分钟</option>
            <option value={300}>每 5 分钟</option>
            <option value={900}>每 15 分钟</option>
            {refreshSeconds > 0 && ![60, 300, 900].includes(refreshSeconds) && (
              <option value={refreshSeconds}>每 {refreshSeconds} 秒</option>
            )}
          </select>
        </label>
        <div className="connection-settings">
          <div>
            <span>flomo 接入</span>
            <span className={flomoConfigured ? "configured" : "muted"}>
              {flomoConfigured ? "已配置" : "未配置"}
            </span>
          </div>
          <div>
            <span>内置 AI</span>
            <span className={aiConfigured ? "configured" : "muted"}>
              {aiConfigured ? "已配置" : "未配置 · 可使用 Codex"}
            </span>
          </div>
          <p>接入配置保存在项目环境变量中。此处不会显示密钥。</p>
        </div>
        <ErrorBox error={error} />
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !tags.trim()}
          onClick={() => {
            setBusy(true);
            setError("");
            const nextTags = Array.from(
              new Set(
                tags
                  .split("\n")
                  .map((tag) => tag.trim().replace(/^#/, ""))
                  .filter(Boolean),
              ),
            );
            void api
              .saveSettings({ pinnedTags: nextTags, refreshSeconds })
              .then((saved) => {
                client.setQueryData(["settings"], saved);
                onClose();
              })
              .catch((error) => setError(messageOf(error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Check size={15} />}
          保存设置
        </button>
      </div>
    </Modal>
  );
}
