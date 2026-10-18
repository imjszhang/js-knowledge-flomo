import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, Link2, Loader2, Plus, RefreshCw } from "lucide-react";
import type { Memo, Workspace } from "../../shared/contracts";
import type { LinkedMemoResolution } from "../../shared/linked-memos";
import { api, messageOf, sourceUrl } from "./api";
import { markdownExcerpt } from "./markdown-text";

type LinkedMemoItem = LinkedMemoResolution["items"][number];
const directionLabels = { outgoing: "当前笔记引用了它", incoming: "它引用了当前笔记", bidirectional: "两条笔记互相引用" };

function LinkedMemoCard({ item, selected, disabled, initialExpanded, onSelect, renderContent }: {
  item: LinkedMemoItem;
  selected: boolean;
  disabled: boolean;
  initialExpanded: boolean;
  onSelect: (memo: Memo) => Promise<void>;
  renderContent: (content: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const memo = item.status === "available" ? item.memo : undefined;
  const title = memo ? markdownExcerpt(memo.content, 160).split("\n").find(line => line.trim()) || "未命名笔记" : "暂时无法读取关联笔记";
  const href = sourceUrl(memo?.url ?? `https://v.flomoapp.com/mine/?memo_id=${encodeURIComponent(item.id)}`);
  return <article className="linked-memo-card">
    <div className="material-meta"><span className="relation-chip background">{directionLabels[item.direction]}</span>{selected && <span className="selected-label"><Check size={12}/>已选用</span>}</div>
    {memo ? <details className="material-reading" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><span className="linked-memo-title">{title}</span><span className="expand-label">{expanded ? "收起正文" : "展开正文"}<ChevronDown size={12}/></span></summary>
      {renderContent(memo.content)}
    </details> : <><h3 className="linked-memo-title">{title}</h3><p className="scope-notice">{item.message || "请重新读取，或在 flomo 中检查这条笔记是否仍可访问。"}</p></>}
    <div className="material-actions">
      {href && <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">打开原笔记<ArrowUpRight size={12}/></a>}
      {memo && (selected ? <span className="scope-notice">已加入本次讨论和写作材料</span> : <button className="button secondary small" disabled={disabled} onClick={() => void onSelect(memo)}><Plus size={13}/>用于这次加工</button>)}
    </div>
  </article>;
}

export function LinkedMemos({ workspace, active, disabled, onSelect, renderContent }: {
  workspace: Workspace;
  active: boolean;
  disabled: boolean;
  onSelect: (memo: Memo) => Promise<void>;
  renderContent: (content: string) => ReactNode;
}) {
  const source = workspace.remote ?? workspace.source;
  const linked = useQuery({
    queryKey: ["linked-memos", workspace.id, source.id, source.content, source.linked_memos, workspace.lastCheckedAt],
    queryFn: ({ signal }) => api.linkedMemos(workspace.id, signal),
    enabled: active,
    retry: false,
    staleTime: 60_000,
  });
  const selected = new Set(workspace.materials.map(memo => memo.id));
  const items = linked.data?.items ?? [];
  return <section className="linked-memos" aria-label="笔记关联内容">
    <div className="section-heading"><h2><Link2 size={15}/>笔记关联内容{linked.data && <span>{items.length}</span>}</h2><button className="text-button" disabled={linked.isFetching} onClick={() => void linked.refetch()}><RefreshCw size={13} className={linked.isFetching ? "spin" : ""}/>重新读取</button></div>
    <p className="section-description">阅读这条笔记引用的笔记，以及引用它的笔记。选用后，完整正文会加入本次讨论和写作材料。</p>
    {linked.isPending && <p className="collector-loading" role="status"><Loader2 size={14} className="spin"/>正在读取关联笔记…</p>}
    {linked.error && <div className="error-box" role="alert"><span>{messageOf(linked.error)}</span><button className="text-button" disabled={linked.isFetching} onClick={() => void linked.refetch()}>重试</button></div>}
    {linked.isSuccess && !items.length && <p className="scope-notice">本次没有找到可确认的笔记关联。</p>}
    {items.map(item => <LinkedMemoCard key={item.id} item={item} selected={selected.has(item.id)} disabled={disabled} initialExpanded={items.length === 1} onSelect={onSelect} renderContent={renderContent}/>)}
    {linked.data?.warnings.map(warning => <p className="scope-notice" key={warning}>{warning}</p>)}
    {linked.data?.truncated && <p className="scope-notice">关联较多，本次只读取了部分笔记；反向引用也受 flomo 搜索范围限制。</p>}
  </section>;
}
