import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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
import { api, messageOf, sourceUrl } from "./api";
import { useChanges, useDebounce, useDraft } from "./hooks";
import InlineDiff from "./InlineDiff";

type LeaveGuard = () => Promise<unknown>;
const viewLabels: Record<WorkbenchView, string> = { note: "笔记", materials: "材料", draft: "草稿" };

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

function excerpt(content: string, length = 180) {
  return content
    .replace(/<[^>]+>/g, "")
    .replace(/[#*_>`]/g, "")
    .trim()
    .slice(0, length);
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

function Modal({
  title,
  children,
  onClose,
  wide = false,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
          ) ?? [],
        );
        if (!elements.length) {
          event.preventDefault();
          return;
        }
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`modal-backdrop ${drawer ? "drawer-backdrop" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""} ${drawer ? "drawer-panel" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
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
  const [tag, setTag] = useState<string>("待编");
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
          <><ErrorBox error={selectedWorkspace.error} retry={() => void selectedWorkspace.refetch()} /><Workbench key={workspaceId} workspace={selectedWorkspace.data} view={view} onView={(next) => void navigate(workspaceId, next, true)} aiConfigured={health.data?.aiConfigured ?? false} setGuard={(value) => { guard.current = value; }} /></>
        ) : ready ? <section className="welcome-panel"><div className="empty-icon"><FileText size={24} /></div><h1>这次想把哪条笔记想清楚？</h1><p>选一条待编，在 Codex 对话中推进。材料、你的选择和草稿会保留在这里。</p><button className="button primary" onClick={() => setLibraryOpen(true)}>选择一条笔记<ArrowRight size={15} /></button><div className="welcome-steps"><span>读笔记</span><ArrowRight size={13}/><span>选材料</span><ArrowRight size={13}/><span>完善草稿</span></div></section> : null}
      </div>
      {libraryOpen && <Modal title="选择要继续的工作" onClose={() => setLibraryOpen(false)} drawer>
        <div className="segmented drawer-tabs"><button className={librarySection === "notes" ? "selected" : ""} onClick={() => setLibrarySection("notes")}>从笔记开始</button><button className={librarySection === "workspaces" ? "selected" : ""} onClick={() => setLibrarySection("workspaces")}>继续加工 <span>{workspaces.data?.length ?? 0}</span></button></div>
        {librarySection === "notes" ? <><nav className="tag-navigation" aria-label="置顶标签">{[...tags, ""].map((item) => <button key={item} className={tag === item ? "selected" : ""} onClick={() => setTag(item)}>{item || "全部"}</button>)}</nav><Library tag={tag} onOpen={openMemo} flomoConfigured={health.data?.flomoConfigured} /></> : <div className="workspace-list">{workspaces.data?.length ? workspaces.data.map((item) => <button key={item.id} className={`workspace-row ${item.id === workspaceId ? "selected" : ""}`} onClick={() => void navigate(item.id)}><div><strong>{item.title}</strong><p>{item.goal || excerpt(item.draft, 90)}</p><span>{date(item.updatedAt, true)} · {item.materials.length} 条材料</span></div><ArrowRight size={16}/></button>) : <div className="empty-state"><h3>还没有加工中的笔记</h3><p>从置顶标签中选择一条笔记即可开始。</p><button className="text-button" onClick={() => setLibrarySection("notes")}>选择笔记<ArrowRight size={14}/></button></div>}</div>}
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
  const [search, setSearch] = useState("");
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
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

function Workbench({ workspace, view, onView, aiConfigured, setGuard }: {
  workspace: Workspace; view: WorkbenchView; onView: (view: WorkbenchView) => void;
  aiConfigured: boolean; setGuard: (guard: LeaveGuard | null) => void;
}) {
  const client = useQueryClient();
  const editor = useDraft(workspace);
  const [preview, setPreview] = useState(false);
  const [materialSearch, setMaterialSearch] = useState(false);
  const [remoteCompare, setRemoteCompare] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [publishPreview, setPublishPreview] = useState<Workspace | null>(null);
  const [publishKey, setPublishKey] = useState("");
  const [copyLabel, setCopyLabel] = useState("复制 Codex 读取命令");
  const [abandonJob, setAbandonJob] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState<DraftRevision | null>(null);
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
  const revisions = useQuery({ queryKey: ["revisions", workspace.id], queryFn: () => api.revisions(workspace.id) });
  const activeJobs = jobs.data?.filter((job) => job.status === "running" || job.status === "uncertain") ?? [];
  const latestWorkspace = editor.acknowledged.version > workspace.version ? editor.acknowledged : workspace;
  const candidates = latestWorkspace.materialCandidates ?? [];
  const selected = latestWorkspace.materials;
  const proposed = candidates.filter((item) => item.status === "proposed");
  const dismissed = candidates.filter((item) => item.status === "dismissed");
  const decisions = latestWorkspace.decisions ?? [];
  const pendingDecisions = decisions.filter((item) => !item.answer);
  const decisionsToReview = decisions.filter((item) => !item.answer || dirtyInputs.has(`decision:${item.id}`));
  const latestRevision = revisions.data?.[0];

  useEffect(() => {
    setGuard(async () => {
      if (goalDirty.current) throw new Error("本次目标尚未保存，请先保存或取消编辑。");
      if (unsavedInputs.current.size) throw new Error("还有未保存的判断或补充思考，请先保存或清空输入再切换笔记。");
      if (editor.session.dirty) await editor.session.flush();
    });
    return () => setGuard(null);
  }, [editor.session]);
  useEffect(() => {
    if (checkedOnOpen.current || !jobs.isSuccess || jobs.data.some((job) => job.kind === "publish" && (job.status === "running" || job.status === "uncertain"))) return;
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
  async function preparePublish() {
    await action("preview", async () => {
      await editor.session.flush();
      const latest = await api.refresh(workspace.id); update(latest);
      if (editor.session.getSnapshot().conflict || editor.session.getSnapshot().review) throw new Error("另一端已修改草稿，请先查看更新。");
      setPublishPreview(latest); setPublishKey(crypto.randomUUID());
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
  function materialCard(memo: Memo, candidate?: MaterialCandidate) {
    const status = candidate?.status ?? "selected";
    return <article className={`context-card ${status}`} key={memo.id}>
      <div className="material-meta"><span className={`relation-chip ${candidate?.relation ?? "background"}`}>{candidate ? relationLabels[candidate.relation] : "参考材料"}</span><span>{date(memo.created_at)}</span>{status === "selected" && <span className="selected-label"><Check size={12}/>已选用</span>}</div>
      <details className="material-reading"><summary>{excerpt(memo.content, 180) || "查看材料原文"}<span className="expand-label">展开原文<ChevronDown size={12}/></span></summary><Markdown>{memo.content}</Markdown>{memo.content_truncated && <p className="scope-notice">此材料尚未读取完整，请在 flomo 中核对原文。</p>}<MemoLink memo={memo}/></details>
      {candidate?.reason && <p className="material-reason"><span>推荐理由</span>{candidate.reason}</p>}
      <div className="material-actions">{status === "selected" ? <button className="text-button subdued" disabled={!!busy} onClick={() => void chooseMaterial(memo, "dismissed")}>移出本次材料</button> : <><button className="button secondary small" disabled={!!busy} onClick={() => void chooseMaterial(memo, "selected")}><Plus size={13}/>用于这次加工</button>{status === "proposed" && <button className="text-button subdued" disabled={!!busy} onClick={() => void chooseMaterial(memo, "dismissed")}>暂时不用</button>}</>}</div>
    </article>;
  }
  const saveStatus = editor.saving ? "保存中…" : editor.conflict ? "有版本冲突" : editor.review ? "有新版本待查看" : editor.error ? "保存失败" : editor.dirty ? "尚未保存" : "已自动保存";
  return (
    <main className="workbench">
      <section className="current-work">
        <h1>{workspace.title}</h1>
        <div className="work-meta"><MemoLink memo={workspace.source}>来源笔记</MemoLink><span>{date(workspace.source.created_at)}</span><details className="work-options"><summary aria-label="当前工作操作">更多<ChevronDown size={12}/></summary><div><button disabled={!!busy} onClick={() => void action("refresh", async () => update(await api.refresh(workspace.id)))}><RefreshCw size={13} className={busy === "refresh" ? "spin" : ""}/>检查 flomo 更新</button><button onClick={() => { void navigator.clipboard.writeText(`npm run --silent workbench -- workspace get ${workspace.id} --json`).then(() => { setCopyLabel("已复制"); setTimeout(() => setCopyLabel("复制 Codex 读取命令"), 2000); }).catch(() => setError("无法访问剪贴板，请通过当前页面地址中的工作区 ID 读取。")); }}><Terminal size={13}/>{copyLabel}</button><p>草稿版本 v{latestWorkspace.version}<br/>flomo 检查于 {date(latestWorkspace.lastCheckedAt, true)}</p></div></details></div>
        <GoalEditor workspace={latestWorkspace} onUpdate={update} onDirty={(dirty) => { goalDirty.current = dirty; }} />
      </section>
      <nav className="work-tabs" aria-label="当前工作视图">{(["note", "materials", "draft"] as WorkbenchView[]).map((item) => <button key={item} className={view === item ? "selected" : ""} aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>{item === "note" ? <FileText size={16}/> : item === "materials" ? <Layers3 size={16}/> : <BookOpen size={16}/>}<span>{viewLabels[item]}</span>{item === "materials" && (selected.length > 0 || proposed.length > 0) && <span className="tab-count" title={`已选 ${selected.length} 条，待选 ${proposed.length} 条`}>{proposed.length ? `${proposed.length} 待选` : selected.length}</span>}{item === "note" && decisionsToReview.length > 0 && <span className="tab-dot"/>}{item === "draft" && (editor.review || editor.conflict) && <span className="tab-dot"/>}</button>)}</nav>
      <div className="work-view">
        <ErrorBox error={error}/>
        {editor.review && <div className="notice update-notice" role="status"><strong>Codex / 另一端更新了草稿</strong><p>{latestRevision?.actor !== "web" && latestRevision?.summary ? latestRevision.summary : "当前阅读和输入保持不变，查看后再采用新版本。"}</p><button className="text-button" onClick={() => setReviewOpen(true)}>查看草稿变化<ArrowRight size={14}/></button></div>}
        {editor.conflict && <div className="notice conflict-notice" role="alert"><strong>另一端更新了草稿，你的输入已保留</strong><p>两份内容都在。比较后选择要保留的版本。</p><button className="text-button" onClick={() => setReviewOpen(true)}>比较并处理<ArrowRight size={14}/></button></div>}
        {latestWorkspace.sourceChanged && <div className="notice remote-notice"><div><strong>flomo 原笔记有新内容</strong><p>本地草稿已保留，写回前需要比较。</p></div><button className="text-button" onClick={() => setRemoteCompare(true)}>比较原文变化<ArrowRight size={14}/></button></div>}
        {activeJobs.length > 0 && <JobList jobs={activeJobs} onAbandon={setAbandonJob} onReconcile={(id) => void action("reconcile", async () => { await api.reconcile(id); await jobs.refetch(); void client.invalidateQueries({ queryKey: ["workspace", workspace.id] }); })}/>}
        <div className="note-view" hidden={view !== "note"}>
          <section className="decision-section" hidden={!pendingDecisions.length && ![...dirtyInputs].some(key => key.startsWith("decision:"))}><div className="section-heading"><h2>需要你判断 <span>{decisionsToReview.length}</span></h2></div><p className="section-description">选择会保留在工作区，Codex 可以接着处理。</p>{decisions.map((decision) => <DecisionCard key={decision.id} decision={decision} disabled={!!busy} onDirty={(dirty) => trackInput(`decision:${decision.id}`, dirty)} onAnswer={async (answer, expectedAnswer) => { const saved = await editor.session.flush(); if (saved.decisions?.find(item => item.id === decision.id)?.answer !== expectedAnswer) throw new Error("这条判断已被另一端更新，请先核对新答案。"); update(await api.answerDecision(workspace.id, decision.id, answer, saved.version)); }}/>)}</section>
          <section className="reading-surface" aria-label="flomo 原文">
            <div className="document-label"><FileText size={13}/><span>flomo 原文</span></div>
            <article className="source-document"><Markdown>{workspace.source.content}</Markdown>{workspace.source.content_truncated && <div className="notice">原文不完整，请检查接入状态后重新读取。</div>}</article>
          </section>
          <div className="supporting-tools">
          <AnnotationComposer workspace={workspace} jobs={jobs.data ?? []} onDirty={(dirty) => trackInput("annotation", dirty)} onCreated={() => void jobs.refetch()}/>
          <div className="next-step"><button className="text-button" onClick={() => onView("materials")}><Layers3 size={15}/>查看相关材料<ArrowRight size={14}/></button>{selected.length > 0 && <span>已选 {selected.length} 条</span>}</div>
          {decisions.some((item) => item.answer) && <details className="quiet-disclosure"><summary>已作出的判断 <span>{decisions.filter((item) => item.answer).length}</span></summary>{decisions.filter((item) => item.answer).map((item) => <div key={item.id} className="answered-decision"><strong>{item.question}</strong><p>{item.answer}</p><span>{date(item.answeredAt ?? undefined, true)} · 已共享给 Codex</span></div>)}</details>}
          <details className="quiet-disclosure"><summary><MessageCircle size={15}/>讨论与补充<span>{workspace.messages.length || ""}</span></summary><ChatPanel onDirty={(dirty) => trackInput("chat", dirty)} workspace={latestWorkspace} aiConfigured={aiConfigured} flush={() => editor.session.flush()} onUpdate={update} onApply={(content, mode) => { if (mode === "append") editor.session.append(content); else editor.session.edit(content); setPreview(false); onView("draft"); }}/></details>
          </div>
        </div>
        <div className="materials-view" hidden={view !== "materials"}><div className="section-heading"><h2>本次加工的材料</h2><button className="button secondary small" onClick={() => setMaterialSearch(true)}><Search size={14}/>查找</button></div><p className="section-description">你选用的内容会成为共享上下文。展开原文核对，再决定是否采用。</p>
          {proposed.length > 0 && <section className="candidate-section"><div className="material-group-label"><span>待你选择</span><span>{proposed.length} 条推荐</span></div>{proposed.map((item) => materialCard(item.memo, item))}</section>}
          <section><div className="material-group-label"><span>已选用</span><span>{selected.length} 条</span></div>{selected.length ? selected.map((memo) => materialCard(memo, candidates.find((item) => item.memo.id === memo.id))) : <div className="empty-state small-empty"><Layers3 size={25}/><h3>先给这次思考找些依据</h3><p>在 Codex 中说“为当前笔记找材料，注明推荐理由”，也可以自己查找。</p><button className="text-button" onClick={() => setMaterialSearch(true)}>查找相关笔记<ArrowRight size={14}/></button></div>}</section>
          {dismissed.length > 0 && <details className="quiet-disclosure"><summary>暂时不用 <span>{dismissed.length}</span></summary>{dismissed.map((item) => materialCard(item.memo, item))}</details>}
        </div>
        <div className="draft-view" hidden={view !== "draft"}><div className="editor-toolbar"><div className="segmented"><button className={!preview ? "selected" : ""} onClick={() => setPreview(false)}>编辑</button><button className={preview ? "selected" : ""} onClick={() => setPreview(true)}>阅读</button></div></div>
          <ErrorBox error={editor.error} retry={editor.error ? () => void editor.session.flush().catch(() => {}) : undefined}/>
          {preview ? <div className="draft-preview"><Markdown>{editor.draft || "草稿还没有内容。"}</Markdown></div> : <textarea className="draft-editor" aria-label="工作草稿" value={editor.draft} onChange={(event) => editor.session.edit(event.target.value)} spellCheck={false} placeholder="写下自己的判断，或让 Codex 把讨论结果整理到这里。"/>}
          <div className="editor-footer"><span>{editor.draft.length.toLocaleString()} 字符 · Markdown</span></div>
          <details className="quiet-disclosure revision-history"><summary><Clock3 size={15}/>草稿修改记录 <span>{revisions.data?.length ?? 0}</span></summary><ErrorBox error={revisions.error} retry={() => void revisions.refetch()}/>{revisions.data?.length ? revisions.data.map((revision) => <button className="revision-row" key={revision.id} onClick={() => setRevisionOpen(revision)}><span><strong>{revision.summary || "更新了草稿"}</strong><small>{revision.actor === "web" ? "你在工作台" : "Codex / 外部助手"} · {date(revision.createdAt, true)} · v{revision.toVersion}</small></span><ArrowRight size={14}/></button>) : <p className="scope-notice">草稿修改后，会在这里保留版本和具体变化。</p>}</details>
        </div>
        {!!jobs.data?.some((job) => !activeJobs.some((active) => active.id === job.id)) && <details className="quiet-disclosure task-history"><summary>已完成和失败的任务</summary><JobList jobs={jobs.data.filter((job) => !activeJobs.some((active) => active.id === job.id))} onAbandon={setAbandonJob} onReconcile={() => {}}/></details>}
        <ErrorBox error={jobs.error} retry={() => void jobs.refetch()}/>
      </div>
      {view === "draft" && <footer className="draft-actionbar"><div><strong className={editor.error ? "error" : ""}>{editor.saving ? <Loader2 size={13} className="spin"/> : !editor.dirty && !editor.review && !editor.conflict ? <CheckCheck size={14}/> : <Circle size={8}/>} {saveStatus}</strong><span>确认写回后才会更新 flomo</span></div><button className="button primary" disabled={!!busy || !!editor.conflict || !!editor.review || activeJobs.some((job) => job.kind === "publish")} onClick={() => void preparePublish()}>{busy === "preview" ? <Loader2 size={14} className="spin"/> : <ArrowUpRight size={15}/>}预览写回</button></footer>}
      {reviewOpen && (editor.review || editor.conflict) && <Modal title={editor.conflict ? "选择要继续的草稿" : "查看另一端的草稿更新"} wide onClose={() => setReviewOpen(false)}><p className="modal-description">{editor.conflict ? "删除标记对应你的当前输入，新增标记对应另一端内容。你的输入仍保留在编辑器中，可关闭此窗口手动合并。" : "这里显示从当前草稿到新版本的变化；采用后才会更新编辑区。"}</p><InlineDiff before={editor.draft} after={(editor.conflict ?? editor.review)!.draft}/><div className="modal-actions"><button className="button secondary" onClick={() => setReviewOpen(false)}>暂不处理</button>{editor.conflict ? <><button className="button secondary" onClick={() => { editor.session.resolve("local"); setReviewOpen(false); }}>保留我的输入并保存</button><button className="button primary" onClick={() => { editor.session.resolve("server"); setReviewOpen(false); onView("draft"); }}>采用另一端版本</button></> : <button className="button primary" onClick={() => { editor.session.acceptReview(); setReviewOpen(false); onView("draft"); }}>采用新版本</button>}</div></Modal>}
      {revisionOpen && <Modal title="草稿改动" wide onClose={() => setRevisionOpen(null)}><p className="modal-description">{revisionOpen.summary || "更新草稿"} · {date(revisionOpen.createdAt, true)} · v{revisionOpen.fromVersion} → v{revisionOpen.toVersion}</p><InlineDiff before={revisionOpen.before} after={revisionOpen.after}/></Modal>}
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

function ChatPanel({
  onDirty,
  workspace,
  aiConfigured,
  flush,
  onUpdate,
  onApply,
}: {
  workspace: Workspace;
  aiConfigured: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onApply: (content: string, mode: "append" | "replace") => void;
  onDirty: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  useEffect(() => { onDirty(!!prompt.length || busy); }, [prompt, busy]);
  const attempt = useRef<{
    prompt: string;
    version: number;
    key: string;
  } | null>(null);
  const runningJobs = useQuery({
    queryKey: ["jobs", workspace.id],
    queryFn: () => api.jobs(workspace.id),
  });
  const runningAI = runningJobs.data?.some(
    (job) => job.kind === "ai" && job.status === "running",
  );
  async function send(useAI: boolean) {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await flush();
      if (useAI) {
        if (!attempt.current || attempt.current.prompt !== prompt.trim())
          attempt.current = {
            prompt: prompt.trim(),
            version: saved.version,
            key: crypto.randomUUID(),
          };
        const current = attempt.current;
        await api.ai(
          workspace.id,
          current.prompt,
          current.version,
          current.key,
        );
        attempt.current = null;
      } else {
        onUpdate(await api.message(workspace.id, prompt.trim(), saved.version));
      }
      setPrompt("");
      void client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
      void client.invalidateQueries({ queryKey: ["jobs", workspace.id] });
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {workspace.messages.length === 0 && (
          <div className="chat-empty">
            <Sparkles size={23} />
            <p>
              这条笔记里，
              <br />
              你最想继续探究什么？
            </p>
            <button
              disabled={busy}
              onClick={() =>
                setPrompt(
                  "结合原笔记和参考材料，帮我找出最值得继续思考的三个问题，并标注对应笔记的来源。",
                )
              }
            >
              帮我找到值得追问的问题
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        {workspace.messages.map((message) => (
          <article className={`chat-message ${message.role}`} key={message.id}>
            <div className="message-meta">
              <span>
                {message.role === "user" ? "我的思考" : "AI 助手"}
                <small>
                  {message.actor === "cli"
                    ? " · CLI"
                    : message.actor === "mcp"
                      ? " · MCP"
                      : ""}
                </small>
              </span>
              <span>{date(message.createdAt, true)}</span>
            </div>
            <Markdown>{message.content}</Markdown>
            {message.role === "assistant" && (
              <button
                className="text-button"
                onClick={() => setApplyMessage(message.content)}
              >
                <FileText size={13} />
                用于草稿
              </button>
            )}
          </article>
        ))}
        {runningAI && (
          <div className="generating">
            <Loader2 size={15} className="spin" />
            正在结合材料思考…
          </div>
        )}
      </div>
      {!aiConfigured && (
        <div className="agent-inline-note">
          <Terminal size={15} />
          <span>
            未配置内置 AI。可以记录问题，再让 Codex 通过 CLI 读取并协助加工。
          </span>
        </div>
      )}
      <ErrorBox error={error} />
      <form
        className="chat-composer"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void send(true);
        }}
      >
        <textarea
          aria-label="讨论问题"
          readOnly={busy}
          placeholder="提出问题，或记录自己的判断…"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            attempt.current = null;
          }}
        />
        <div>
          <button
            type="button"
            className="text-button"
            disabled={!prompt.trim() || busy}
            onClick={() => void send(false)}
          >
            保存思考
          </button>
          <button
            className="button primary small"
            type="submit"
            disabled={!prompt.trim() || busy || !aiConfigured || runningAI}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            请 AI 一起想
          </button>
        </div>
      </form>
      {applyMessage && (
        <Modal title="将回答用于草稿" onClose={() => setApplyMessage(null)}>
          <p className="modal-description">
            选择追加到当前草稿，或用这段回答替换草稿。更改会自动保存到工作台。
          </p>
          <div className="apply-preview">
            <Markdown>{applyMessage}</Markdown>
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => {
                onApply(applyMessage, "append");
                setApplyMessage(null);
              }}
            >
              追加到草稿
            </button>
            <button
              className="button primary"
              onClick={() => {
                onApply(applyMessage, "replace");
                setApplyMessage(null);
              }}
            >
              替换当前草稿
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
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
            <strong>{job.kind === "publish" ? "写回 flomo" : job.kind === "annotation" ? "新建批注" : "AI 讨论"}</strong>
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
  const [key, setKey] = useState(() => localStorage.getItem(`${storageKey}:request`) ?? crypto.randomUUID());
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
      <p className="scope-notice">关联原笔记：<MemoLink memo={workspace.source}>{workspace.title}</MemoLink></p>
      <ErrorBox error={error}/>
      {!current && <button className="button primary" disabled={busy || !content.trim()} onClick={() => { setBusy(true); setError(""); void api.annotate(workspace.id, content, key).then(job => {setSubmitted(job); onCreated();}).catch(error => setError(messageOf(error))).finally(() => setBusy(false)); }}>{busy ? "正在提交…" : "创建批注笔记"}</button>}
      {current && <p role="status">{current.status === "running" ? "正在创建批注…" : current.status === "succeeded" ? "已创建批注并关联原笔记" : current.error}</p>}
      {current?.status === "succeeded" && <button className="text-button" onClick={() => {setContent(""); setKey(crypto.randomUUID()); setSubmitted(null);}}>再写一条批注</button>}
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
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [excludeTag, setExcludeTag] = useState("");
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
