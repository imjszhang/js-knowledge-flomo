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
import type { Job, Memo, Settings, Workspace } from "../../shared/contracts";
import { pinnedTags } from "../../shared/contracts";
import { api, messageOf, sourceUrl } from "./api";
import { useChanges, useDebounce, useDraft } from "./hooks";

type LeaveGuard = () => Promise<unknown>;
const descriptions: Record<string, string> = {
  待编: "给还没想完的念头，留一点生长的空间。",
  概要: "读过的内容，在这里重新相遇。",
  想法: "留下自己的判断，也给它改变的机会。",
  摘要: "那些你特意留下的句子，值得再读一次。",
  资源: "当新的问题出现，找到用得上的积累。",
};
const tagIcons = [FileText, BookOpen, Sparkles, Layers3, Link2];

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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
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
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
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
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: api.workspaces,
  });
  const [workspaceId, setWorkspaceId] = useState(() =>
    new URLSearchParams(location.search).get("workspace"),
  );
  const [tag, setTag] = useState<string>("待编");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const guard = useRef<LeaveGuard | null>(null);
  const connection = useChanges();
  const selectedWorkspace = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api.workspace(workspaceId!),
    enabled: !!workspaceId,
  });
  const tags = settings.data?.pinnedTags ?? [...pinnedTags];

  async function navigate(id: string | null, nextTag = tag, replace = false) {
    try {
      if (id !== workspaceId && guard.current) await guard.current();
      setNavigationError("");
      setWorkspaceId(id);
      setTag(nextTag);
      setSidebarOpen(false);
      const url = new URL(location.href);
      if (id) url.searchParams.set("workspace", id);
      else url.searchParams.delete("workspace");
      history[replace ? "replaceState" : "pushState"]({}, "", url);
    } catch (error) {
      setNavigationError(`切换前需要保存当前草稿：${messageOf(error)}`);
    }
  }

  useEffect(() => {
    const pop = () => {
      const nextId = new URLSearchParams(location.search).get("workspace");
      void (async () => {
        try {
          if (guard.current) await guard.current();
          setWorkspaceId(nextId);
          setNavigationError("");
        } catch (error) {
          const restored = new URL(location.href);
          if (workspaceId) restored.searchParams.set("workspace", workspaceId);
          else restored.searchParams.delete("workspace");
          history.pushState({}, "", restored);
          setNavigationError(`草稿仍在当前页面：${messageOf(error)}`);
        }
      })();
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [workspaceId]);

  async function openMemo(memo: Memo) {
    const created = await api.createWorkspace(memo.id);
    client.setQueryData(["workspace", created.id], created);
    await client.invalidateQueries({ queryKey: ["workspaces"] });
    await navigate(created.id);
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="收起导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => void navigate(null)}
          aria-label="返回知识工作台"
        >
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <span>
            flomo<span className="brand-sub">知识工作台</span>
          </span>
        </button>
        <div className="sidebar-label">
          我的知识入口 <span>PINNED</span>
        </div>
        <nav aria-label="置顶标签">
          {tags.map((item, index) => {
            const Icon = tagIcons[index % tagIcons.length];
            return (
              <button
                key={item}
                className={`nav-item ${!workspaceId && tag === item ? "active" : ""}`}
                onClick={() => void navigate(null, item)}
              >
                <Icon size={18} />
                <span>{item}</span>
                {!workspaceId && tag === item && <span className="nav-dot" />}
              </button>
            );
          })}
          <button
            className={`nav-item ${!workspaceId && tag === "" ? "active" : ""}`}
            onClick={() => void navigate(null, "")}
          >
            <Hash size={18} />
            <span>全部笔记</span>
          </button>
        </nav>
        <div className="sidebar-label workspace-label">
          加工中的思考 <span>{workspaces.data?.length ?? "—"}</span>
        </div>
        <div className="workspace-nav">
          {workspaces.isPending ? (
            <div className="sidebar-hint">正在读取工作区…</div>
          ) : workspaces.isError ? (
            <div className="sidebar-hint">
              工作区读取失败
              <button
                className="text-button"
                onClick={() => void workspaces.refetch()}
              >
                重试
              </button>
            </div>
          ) : workspaces.data.length === 0 ? (
            <div className="sidebar-hint">
              打开一条笔记，
              <br />
              开始你的第一个工作区。
            </div>
          ) : (
            workspaces.data.map((item) => (
              <button
                key={item.id}
                className={`workspace-nav-item ${workspaceId === item.id ? "active" : ""}`}
                onClick={() => void navigate(item.id)}
              >
                <span className="workspace-bullet" />
                <span>{item.title || "未命名的思考"}</span>
              </button>
            ))
          )}
        </div>
        <div className="sidebar-bottom">
          <div
            className="connection"
            title={
              connection.lastChange
                ? `最近变更：${connection.lastChange.actor} · ${date(connection.lastChange.createdAt, true)}`
                : "Web、CLI 和 MCP 共用工作区"
            }
          >
            <span
              className={`status-dot ${connection.connected ? "online" : ""}`}
            />
            {connection.connected ? "与工作台实时连接" : "连接中，将自动重连"}
          </div>
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={16} />
            工作台设置
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-footnote">记录是思考的开始。</div>
        </div>
      </aside>
      <div className="app-main">
        <div className="mobile-toolbar">
          <button
            className="icon-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开导航"
          >
            <PanelLeftClose size={20} />
          </button>
          <span>flomo · 知识工作台</span>
          <span
            className={`status-dot ${connection.connected ? "online" : ""}`}
          />
        </div>
        <ErrorBox error={navigationError} />
        {workspaceId ? (
          selectedWorkspace.isPending ? (
            <Loading label="正在打开工作区…" />
          ) : selectedWorkspace.isError ? (
            <div className="page-error">
              <ErrorBox
                error={selectedWorkspace.error}
                retry={() => void selectedWorkspace.refetch()}
              />
              <button
                className="button secondary"
                onClick={() => void navigate(null)}
              >
                <ArrowLeft size={15} />
                返回笔记
              </button>
            </div>
          ) : (
            <Workbench
              key={workspaceId}
              workspace={selectedWorkspace.data}
              aiConfigured={health.data?.aiConfigured ?? false}
              setGuard={(value) => {
                guard.current = value;
              }}
              onBack={() => void navigate(null)}
            />
          )
        ) : (
          <Library
            tag={tag}
            onOpen={openMemo}
            flomoConfigured={health.data?.flomoConfigured}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsDialog
          settings={settings.data}
          aiConfigured={health.data?.aiConfigured ?? false}
          flomoConfigured={health.data?.flomoConfigured ?? false}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const query = useDebounce(search);
  const invalidRange = !!startDate && !!endDate && startDate > endDate;
  const memos = useQuery({
    queryKey: ["memos", tag, query, startDate, endDate],
    queryFn: () =>
      api.memos({ q: query, tag, startDate, endDate, limit: "50" }),
    enabled: !invalidRange,
  });
  return (
    <main className="library">
      <header className="library-header">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            YOUR KNOWLEDGE, IN PROGRESS
          </div>
          <h1>
            {tag === "待编" ? (
              <>
                把记录，<span>慢慢想明白。</span>
              </>
            ) : (
              tag || "你的全部积累"
            )}
          </h1>
          <p>{descriptions[tag] ?? "带着一个问题，重新发现过去留下的线索。"}</p>
        </div>
        <div className="header-note">
          收集 → 连接 → 思考
          <br />
          <strong>从一条笔记开始</strong>
        </div>
      </header>
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
                <h3>还没有找到相关笔记</h3>
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

function Workbench({
  workspace,
  aiConfigured,
  setGuard,
  onBack,
}: {
  workspace: Workspace;
  aiConfigured: boolean;
  setGuard: (guard: LeaveGuard | null) => void;
  onBack: () => void;
}) {
  const client = useQueryClient();
  const editor = useDraft(workspace);
  const [panel, setPanel] = useState<"materials" | "chat">("materials");
  const [preview, setPreview] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [materialSearch, setMaterialSearch] = useState(false);
  const [remoteCompare, setRemoteCompare] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [publishPreview, setPublishPreview] = useState<Workspace | null>(null);
  const [publishKey, setPublishKey] = useState("");
  const [copyLabel, setCopyLabel] = useState("复制 CLI 命令");
  const [abandonJob, setAbandonJob] = useState<string | null>(null);
  const checkedOnOpen = useRef(false);
  const jobs = useQuery({
    queryKey: ["jobs", workspace.id],
    queryFn: () => api.jobs(workspace.id),
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "running") ? 1500 : false,
  });
  const activeJobs =
    jobs.data?.filter(
      (job) => job.status === "running" || job.status === "uncertain",
    ) ?? [];
  const latestWorkspace =
    editor.acknowledged.version > workspace.version
      ? editor.acknowledged
      : workspace;

  useEffect(() => {
    setGuard(() => editor.session.flush());
    return () => setGuard(null);
  }, [editor.session]);

  useEffect(() => {
    if (checkedOnOpen.current || !jobs.isSuccess) return;
    if (
      jobs.data.some(
        (job) =>
          job.kind === "publish" &&
          (job.status === "running" || job.status === "uncertain"),
      )
    )
      return;
    checkedOnOpen.current = true;
    if (Date.now() - Date.parse(workspace.lastCheckedAt) <= 60_000) return;
    void api
      .refresh(workspace.id)
      .then(update)
      .catch((error) =>
        setError(
          `打开时检查 flomo 更新失败，已保留本地草稿：${messageOf(error)}`,
        ),
      );
  }, [jobs.isSuccess, jobs.data, workspace.id, workspace.lastCheckedAt]);

  function update(next: Workspace) {
    client.setQueryData<Workspace>(["workspace", next.id], (previous) =>
      !previous || previous.version <= next.version ? next : previous,
    );
    editor.session.receive(next);
    void client.invalidateQueries({ queryKey: ["workspaces"] });
  }

  async function action(name: string, operation: () => Promise<unknown>) {
    setBusy(name);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(messageOf(error));
      void client.invalidateQueries({ queryKey: ["workspace", workspace.id] });
    } finally {
      setBusy(null);
    }
  }

  async function preparePublish() {
    await action("preview", async () => {
      await editor.session.flush();
      const latest = await api.refresh(workspace.id);
      update(latest);
      if (editor.session.getSnapshot().conflict)
        throw new Error("另一端已修改草稿，请先处理冲突。");
      setPublishPreview(latest);
      setPublishKey(crypto.randomUUID());
    });
  }

  async function publish() {
    if (!publishPreview) return;
    await action("publish", async () => {
      const job = await api.publish(
        workspace.id,
        publishPreview.version,
        publishKey,
      );
      client.setQueryData<Job[]>(["jobs", workspace.id], (previous) => [
        job,
        ...(previous ?? []).filter((item) => item.id !== job.id),
      ]);
      setPublishPreview(null);
      void client.invalidateQueries({ queryKey: ["jobs", workspace.id] });
    });
  }

  return (
    <main className="workbench">
      <header className="workbench-topbar">
        <div className="breadcrumb">
          <button
            className="icon-button"
            aria-label="返回笔记列表"
            onClick={onBack}
          >
            <ArrowLeft size={17} />
          </button>
          <span>我的工作区</span>
          <span>/</span>
          <strong>{workspace.title}</strong>
        </div>
        <div className="topbar-actions">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void action("refresh", async () =>
                update(await api.refresh(workspace.id)),
              )
            }
          >
            <RefreshCw size={14} className={busy === "refresh" ? "spin" : ""} />
            <span>检查 flomo 更新</span>
          </button>
          <button
            className="button primary"
            disabled={
              !!busy ||
              !!editor.conflict ||
              activeJobs.some((job) => job.kind === "publish")
            }
            onClick={() => void preparePublish()}
          >
            {busy === "preview" ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <ArrowUpRight size={15} />
            )}
            预览并写回
          </button>
        </div>
      </header>
      <div className="workspace-statusline">
        <span>
          <span className="status-dot online" />
          共享工作区 · v{editor.acknowledged.version}
        </span>
        <span>flomo 最近检查：{date(latestWorkspace.lastCheckedAt, true)}</span>
        <button
          className="text-button cli-copy"
          onClick={() => {
            void navigator.clipboard
              .writeText(
                `npm run --silent workbench -- workspace get ${workspace.id} --json`,
              )
              .then(() => {
                setCopyLabel("命令已复制");
                setTimeout(() => setCopyLabel("复制 CLI 命令"), 2000);
              })
              .catch(() =>
                setError(
                  "无法访问剪贴板，可在地址栏复制工作区 ID 后通过 CLI 打开。",
                ),
              );
          }}
        >
          <Terminal size={13} />
          {copyLabel}
        </button>
      </div>
      <ErrorBox error={error} />
      {latestWorkspace.sourceChanged && (
        <div className="notice remote-notice">
          <div>
            <strong>flomo 原笔记有新内容</strong>
            <span>本地草稿已保留。写回前请比较变化并更新基准。</span>
          </div>
          <button
            className="button secondary small"
            onClick={() => setRemoteCompare(true)}
          >
            比较原文变化
          </button>
        </div>
      )}
      {editor.conflict && (
        <div className="conflict-panel" role="alert">
          <div>
            <strong>另一端更新了草稿，你的输入已保留</strong>
            <p>
              当前服务端为 v{editor.conflict.version}
              。选择一个版本继续，或先手动合并文本。
            </p>
          </div>
          <div className="comparison">
            <div>
              <h4>你的未保存草稿</h4>
              <pre>{editor.draft}</pre>
            </div>
            <div>
              <h4>服务端最新草稿</h4>
              <pre>{editor.conflict.draft}</pre>
            </div>
          </div>
          <div className="button-row">
            <button
              className="button secondary small"
              onClick={() => editor.session.resolve("server")}
            >
              采用服务端草稿
            </button>
            <button
              className="button primary small"
              onClick={() => editor.session.resolve("local")}
            >
              将我的草稿保存为新版本
            </button>
          </div>
        </div>
      )}
      <div className="workspace-body">
        <section className="editor-column">
          <div className="editor-heading">
            <div className="eyebrow">A THOUGHT IN THE MAKING</div>
            <h1>{workspace.title}</h1>
            <div className="editor-source-meta">
              <span className="tag-chip">工作草稿</span>
              <MemoLink memo={workspace.source}>来源笔记</MemoLink>
            </div>
          </div>
          <div className={`original-note ${sourceOpen ? "expanded" : ""}`}>
            <button
              className="original-toggle"
              onClick={() => setSourceOpen(!sourceOpen)}
            >
              <FileText size={15} />
              <span>加工前的原笔记</span>
              <span>{date(workspace.source.created_at)}</span>
              <ChevronDown size={15} />
            </button>
            {sourceOpen && (
              <div className="original-body">
                <Markdown>{workspace.source.content}</Markdown>
                {workspace.source.content_truncated && (
                  <div className="notice">
                    原笔记内容不完整，请检查接入状态后重新读取。
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="editor-toolbar">
            <div className="segmented">
              <button
                className={!preview ? "selected" : ""}
                onClick={() => setPreview(false)}
              >
                编辑
              </button>
              <button
                className={preview ? "selected" : ""}
                onClick={() => setPreview(true)}
              >
                阅读预览
              </button>
            </div>
            <div className={`save-status ${editor.error ? "error" : ""}`}>
              {editor.saving ? (
                <>
                  <Loader2 size={13} className="spin" />
                  保存中
                </>
              ) : editor.conflict ? (
                <>等待解决冲突</>
              ) : editor.error ? (
                <button
                  className="text-button"
                  onClick={() => void editor.session.flush().catch(() => {})}
                >
                  保存失败 · 重试
                </button>
              ) : editor.dirty ? (
                <>
                  <Circle size={8} />
                  尚未保存
                </>
              ) : (
                <>
                  <CheckCheck size={14} />
                  已保存
                </>
              )}
            </div>
          </div>
          <ErrorBox error={editor.error} />
          {preview ? (
            <div className="draft-preview">
              <Markdown>{editor.draft || "草稿还没有内容。"}</Markdown>
            </div>
          ) : (
            <textarea
              className="draft-editor"
              aria-label="工作草稿"
              value={editor.draft}
              onChange={(event) => editor.session.edit(event.target.value)}
              spellCheck={false}
              placeholder="把还没想清楚的部分写下来。从一个问题、一个例子开始…"
            />
          )}
          <div className="editor-footer">
            <span>
              {editor.draft.length.toLocaleString()} 字符 · 支持 Markdown
            </span>
            <span>自动保存到工作台，写回后才会修改 flomo</span>
          </div>
          <div className="workflow-note">
            <span>01 读原文</span>
            <span>02 找联系</span>
            <span>03 写下自己的理解</span>
            <span>04 确认后写回</span>
          </div>
        </section>
        <aside className="assistant-column">
          <div className="assistant-tabs">
            <button
              className={panel === "materials" ? "selected" : ""}
              onClick={() => setPanel("materials")}
            >
              <Layers3 size={16} />
              参考材料<span>{workspace.materials.length}</span>
            </button>
            <button
              className={panel === "chat" ? "selected" : ""}
              onClick={() => setPanel("chat")}
            >
              <MessageCircle size={16} />
              一起想想<span>{workspace.messages.length}</span>
            </button>
          </div>
          {panel === "materials" ? (
            <div className="materials-panel">
              <div className="panel-intro">
                <h3>给想法一些上下文</h3>
                <p>选择相关的原文、观点和反例。AI 将依据这些材料与你讨论。</p>
                <button
                  className="button secondary add-material"
                  onClick={() => setMaterialSearch(true)}
                >
                  <Plus size={15} />
                  查找并添加材料
                </button>
              </div>
              {workspace.materials.length ? (
                <div className="material-list">
                  {workspace.materials.map((memo, index) => (
                    <article className="material-card" key={memo.id}>
                      <div className="material-meta">
                        <span>
                          材料 {String(index + 1).padStart(2, "0")} ·{" "}
                          {date(memo.created_at)}
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`移除材料 ${index + 1}`}
                          disabled={!!busy}
                          onClick={() =>
                            void action("material", async () => {
                              const saved = await editor.session.flush();
                              update(
                                await api.materials(
                                  workspace.id,
                                  saved.materials
                                    .filter((item) => item.id !== memo.id)
                                    .map((item) => item.id),
                                  saved.version,
                                ),
                              );
                            })
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <details>
                        <summary>{excerpt(memo.content, 130)}</summary>
                        <Markdown>{memo.content}</Markdown>
                      </details>
                      <div className="memo-tags">
                        {memo.tags.slice(0, 3).map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </div>
                      <MemoLink memo={memo} />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="materials-empty">
                  <Layers3 size={28} />
                  <p>
                    连接两条笔记，
                    <br />
                    可能就多一个新的角度。
                  </p>
                </div>
              )}
              <div className="agent-tip">
                <Terminal size={17} />
                <div>
                  <strong>让 Codex 参与思考</strong>
                  <p>
                    在当前对话中让 Codex
                    读取这个工作区、查找材料或更新草稿，页面会自动同步。
                  </p>
                  <code>{workspace.id}</code>
                </div>
              </div>
            </div>
          ) : (
            <ChatPanel
              workspace={workspace}
              aiConfigured={aiConfigured}
              flush={() => editor.session.flush()}
              onUpdate={update}
              onApply={(content, mode) => {
                if (mode === "append") editor.session.append(content);
                else editor.session.edit(content);
                setPreview(false);
              }}
            />
          )}
          <JobList
            jobs={jobs.data ?? []}
            onAbandon={setAbandonJob}
            onReconcile={(id) =>
              void action("reconcile", async () => {
                await api.reconcile(id);
                await jobs.refetch();
                void client.invalidateQueries({
                  queryKey: ["workspace", workspace.id],
                });
              })
            }
          />
          <ErrorBox error={jobs.error} retry={() => void jobs.refetch()} />
        </aside>
      </div>
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
          selected={workspace.materials.map((memo) => memo.id)}
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
          <div className="comparison document-comparison">
            <div>
              <h3>之前的原文</h3>
              <pre>{workspace.source.content}</pre>
            </div>
            <div>
              <h3>flomo 当前内容</h3>
              <pre>
                {latestWorkspace.remote?.content ?? "请重新检查远端内容"}
              </pre>
            </div>
          </div>
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
          <div className="comparison document-comparison">
            <div>
              <h3>flomo 原文</h3>
              <pre>{publishPreview.source.content}</pre>
            </div>
            <div>
              <h3>即将写回的草稿</h3>
              <pre>{publishPreview.draft}</pre>
            </div>
          </div>
          {publishPreview.sourceChanged && (
            <div className="notice">
              flomo 原文已改变，请先关闭预览，比较远端变化并更新基准。
            </div>
          )}
          {workspace.version !== publishPreview.version && (
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
                workspace.version !== publishPreview.version ||
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

function ChatPanel({
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
}) {
  const client = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
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
      <div className="panel-intro">
        <h3>先把问题问清楚</h3>
        <p>让材料支持你的思考，把有价值的回答整理到草稿。</p>
      </div>
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
            <strong>{job.kind === "publish" ? "写回 flomo" : "AI 讨论"}</strong>
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
          {job.status === "uncertain" && (
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
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useDebounce(query);
  const isRelated = !search.trim() && !tag;
  const memos = useQuery({
    queryKey: ["material-search", sourceId, search, tag],
    queryFn: () =>
      isRelated
        ? api
            .related(sourceId)
            .then((memos) => ({ memos, limit: 30, possiblyLimited: false }))
        : api.memos({ q: search, tag, limit: "30" }),
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
          {pinnedTags.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </div>
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
          <div className="empty-state">没有找到相关材料</div>
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
          仅展示本次搜索的前 {memos.data.limit} 条结果，可缩小关键词范围。
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
