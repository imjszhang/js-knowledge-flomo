import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, Link2, Loader2, Plus, RefreshCw } from "lucide-react";
import type { CollectorArticle, CollectorArticleSummary, CollectorMaterial, Workspace } from "../../shared/contracts";
import { api, messageOf, sourceUrl } from "./api";

type RenderContent = (content: string) => ReactNode;

function ArticleLink({ url, label = "查看来源网页" }: { url: string; label?: string }) {
  const href = sourceUrl(url);
  return href ? <a className="text-link collector-link" href={href} target="_blank" rel="noopener noreferrer">{label}<ArrowUpRight size={13}/></a> : null;
}

function ArticleContent({ article, renderContent }: { article: CollectorArticle; renderContent: RenderContent }) {
  return <div className="collector-content">
    {article.content ? renderContent(article.content) : <p className="scope-notice">这条收藏尚未保存正文，可以查看摘要或打开来源网页。</p>}
    {article.contentTruncated && <p className="scope-notice">正文较长，此处保留的是部分内容。请打开来源网页核对全文。</p>}
    {(article.summary || article.digest) && <details className="quiet-disclosure"><summary>收藏中的摘要与概要</summary>{article.summary && renderContent(article.summary)}{article.digest && renderContent(article.digest)}</details>}
    <ArticleLink url={article.sourceUrl}/>
  </div>;
}

function ArticlePreview({ article, selected, disabled, onAttach, renderContent }: {
  article: CollectorArticleSummary;
  selected: boolean;
  disabled: boolean;
  onAttach: (id: string) => Promise<void>;
  renderContent: RenderContent;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = useQuery({
    queryKey: ["collectorArticle", article.id],
    queryFn: ({ signal }) => api.source(article.id, signal),
    enabled: expanded,
    retry: false,
  });
  return <article className="collector-match">
    <details className="material-reading" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><span className="collector-title">{article.title || "未命名收藏"}</span><span className="expand-label"><span>{expanded ? "收起正文" : "查看正文"}</span><ChevronDown size={12}/></span></summary>
      {detail.isPending && <p className="collector-loading" role="status"><Loader2 size={14} className="spin"/>正在读取收藏正文…</p>}
      {detail.error && <div className="error-box" role="alert"><span>{messageOf(detail.error)}</span><button className="text-button" disabled={detail.isFetching} onClick={() => void detail.refetch()}>重试</button></div>}
      {detail.data && <ArticleContent article={detail.data} renderContent={renderContent}/>}
    </details>
    <div className="material-actions">
      {selected ? <span className="selected-label"><Check size={12}/>已选用，可在本次材料中查看快照</span> : <button className="button secondary small" disabled={disabled} onClick={() => void onAttach(article.id)}><Plus size={13}/>用于这次加工</button>}
      {!expanded && <ArticleLink url={article.sourceUrl}/>}
    </div>
  </article>;
}

export function CollectorSources({ workspace, configured, scope, disabled, onAttach, renderContent }: {
  workspace: Workspace;
  configured: boolean | undefined;
  scope: "source" | "all";
  disabled: boolean;
  onAttach: (id: string) => Promise<void>;
  renderContent: RenderContent;
}) {
  const sources = useQuery({
    queryKey: ["sources", workspace.id, [workspace.source, ...workspace.materials].map(({ id, content }) => ({ id, content }))],
    queryFn: ({ signal }) => api.sources(workspace.id, signal),
    enabled: configured === true,
    retry: false,
  });
  const items = sources.data?.items.filter((item) => scope === "all" || item.memoIds.includes(workspace.source.id)) ?? [];
  const selected = new Set(workspace.collectorMaterials?.map((item) => item.article.id));
  const connected = configured !== false && sources.data?.configured !== false;
  return <section className="collector-sources" aria-label="概要关联原文">
    <div className="section-heading"><h2><Link2 size={15}/>概要关联原文</h2>{configured === true && <button className="text-button" disabled={sources.isFetching} onClick={() => void sources.refetch()}><RefreshCw size={13} className={sources.isFetching ? "spin" : ""}/>重新查找</button>}</div>
    <p className="section-description">{scope === "source" ? "按这条笔记里的链接查找收藏全文，选用后会共享给 Codex。" : "查找当前笔记和已选 flomo 材料中的链接。展开正文后，可选用对应收藏。"}</p>
    {!connected ? <p className="scope-notice">收藏库尚未连接。连接收藏库后，就能在这里读取概要对应的原文。</p> : configured === undefined ? <p className="scope-notice">正在检查收藏库连接…</p> : <>
      {sources.isPending && <p className="collector-loading" role="status"><Loader2 size={14} className="spin"/>正在查找关联原文…</p>}
      {sources.error && <div className="error-box" role="alert"><span>{messageOf(sources.error)}</span><button className="text-button" disabled={sources.isFetching} onClick={() => void sources.refetch()}>重试</button></div>}
      {sources.isSuccess && !items.length && <p className="scope-notice">{scope === "source" ? "这条笔记中没有可关联的链接。" : "当前笔记和已选材料中没有可关联的链接。"}</p>}
      {items.map((item) => <div className={`collector-source ${item.status}`} key={item.url}>
        <div className="collector-source-heading"><span className="collector-source-status">{item.status === "matched" ? "已找到收藏原文" : item.status === "missing" ? "尚未找到收藏" : item.status === "ambiguous" ? "找到多条收藏，请核对后选择" : "暂时无法查询收藏库"}</span>{scope === "all" && <span>{item.memoIds.includes(workspace.source.id) ? "当前笔记" : "已选材料"}</span>}</div>
        <ArticleLink url={item.url} label={item.url}/>
        {item.message && <p className="scope-notice">{item.message}</p>}
        {item.status === "missing" && !item.message && <p className="scope-notice">收藏库中没有与此链接完全一致的记录，可能尚未收藏或链接格式不同。</p>}
        {item.status === "unavailable" && !item.message && <p className="scope-notice">请恢复收藏库连接后重新查找，已选材料仍可使用。</p>}
        {item.articles.map((article) => <ArticlePreview key={article.id} article={article} selected={selected.has(article.id)} disabled={disabled} onAttach={onAttach} renderContent={renderContent}/>)}
      </div>)}
      {sources.data?.truncated && <p className="scope-notice">链接较多，本次只查询了部分链接。</p>}
    </>}
  </section>;
}

export function CollectorMaterialCard({ material, disabled, configured, onRefresh, onRemove, renderContent }: {
  material: CollectorMaterial;
  disabled: boolean;
  configured: boolean | undefined;
  onRefresh: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  renderContent: RenderContent;
}) {
  const fetched = new Date(material.fetchedAt);
  const fetchedLabel = Number.isNaN(fetched.getTime()) ? material.fetchedAt : fetched.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return <article className="context-card selected collector-material">
    <div className="material-meta"><span className="relation-chip background">收藏原文</span><span className="selected-label"><Check size={12}/>已选用</span></div>
    <details className="material-reading"><summary><span className="collector-title">{material.article.title || "未命名收藏"}</span><span className="expand-label"><span className="when-collapsed">展开原文</span><span className="when-expanded">收起原文</span><ChevronDown size={12}/></span></summary><ArticleContent article={material.article} renderContent={renderContent}/></details>
    <p className="scope-notice">已保存 {fetchedLabel} 的内容快照，网页和 Codex 共用这份材料。</p>
    <div className="material-actions"><button className="text-button" disabled={disabled || configured !== true} onClick={() => void onRefresh(material.article.id)}><RefreshCw size={13}/>刷新内容快照</button><button className="text-button subdued" disabled={disabled} onClick={() => void onRemove(material.article.id)}>移出本次材料</button></div>
  </article>;
}
