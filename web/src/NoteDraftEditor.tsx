import {useEffect, useState, type ReactNode} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {ArrowUpRight, Check, Loader2, Save} from "lucide-react";
import type {NoteDraft, Workspace} from "../../shared/contracts";
import {formatNoteDraft} from "../../shared/note-drafts";
import {api, messageOf, sourceUrl} from "./api";
import {useAnalysisInput} from "./analysis-forms";
import Modal from "./Modal";

type DraftInput = Pick<NoteDraft, "title" | "content">;
type Props = {
  workspace: Workspace;
  draft: NoteDraft;
  disabled: boolean;
  flush: () => Promise<Workspace>;
  onUpdate: (workspace: Workspace) => void;
  onDirty: (dirty: boolean) => void;
  renderContent: (content: string) => ReactNode;
};

const statusLabels: Record<NoteDraft["status"], string> = {
  draft: "未创建笔记",
  publishing: "正在创建笔记",
  published: "已创建笔记",
  uncertain: "创建结果待核对",
  failed: "创建未完成",
};

function inputOf(draft: DraftInput): DraftInput {
  return {title: draft.title, content: draft.content};
}

function signature(draft: DraftInput) {
  return JSON.stringify(inputOf(draft));
}

export default function NoteDraftEditor(props: Props) {
  return <Editor key={`${props.workspace.id}:${props.draft.id}`} {...props}/>;
}

function Editor({workspace, draft, disabled, flush, onUpdate, onDirty, renderContent}: Props) {
  const client = useQueryClient();
  const initial = inputOf(draft);
  const [editing, setEditing] = useAnalysisInput(
    `flomo:note-draft:${workspace.id}:${draft.id}`,
    {baseline: initial, input: initial},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{content: string; version: number; key: string} | null>(null);
  const input = editing.input;
  const dirty = signature(input) !== signature(editing.baseline);
  const remoteChanged = signature(editing.baseline) !== signature(draft);
  const locked = ["publishing", "published", "uncertain"].includes(draft.status);
  const hasText = !!(input.title.trim() || input.content.trim());
  const publishLength = formatNoteDraft({...draft, ...input}).length;

  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy]);
  useEffect(() => {
    if (!dirty && !busy && remoteChanged) {
      const latest = inputOf(draft);
      setEditing({baseline: latest, input: latest});
    }
  }, [dirty, busy, remoteChanged, draft]);

  function change(next: Partial<DraftInput>) {
    setEditing({...editing, input: {...input, ...next}});
  }

  function reset() {
    const latest = inputOf(draft);
    setEditing({baseline: latest, input: latest});
    setError("");
    setPreview(null);
  }

  function refresh() {
    void client.invalidateQueries({queryKey: ["workspace", workspace.id]});
  }

  async function save() {
    if (busy || disabled || locked || (dirty && remoteChanged)) return;
    setBusy(true);
    setError("");
    try {
      const saved = await flush();
      const latest = saved.noteDrafts?.find(item => item.id === draft.id);
      if (!latest || signature(latest) !== signature(editing.baseline)) {
        throw new Error("另一端已修改这份草稿，你的输入已保留。请核对最新内容后再保存。");
      }
      if (!["draft", "failed"].includes(latest.status)) {
        throw new Error("这份草稿已开始创建笔记，你的输入已保留，请先核对创建结果。");
      }
      const updated = await api.saveNoteDraft(workspace.id, draft.id, {...input, baseVersion: saved.version});
      onUpdate(updated);
      const confirmed = updated.noteDrafts?.find(item => item.id === draft.id);
      if (confirmed) {
        const next = inputOf(confirmed);
        setEditing({baseline: next, input: next});
      }
    } catch (caught) {
      setError(messageOf(caught));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function preparePreview() {
    if (busy || disabled || locked || dirty || remoteChanged || !hasText) return;
    setBusy(true);
    setError("");
    try {
      const saved = await flush();
      const latest = saved.noteDrafts?.find(item => item.id === draft.id);
      if (!latest || signature(latest) !== signature(input) || !["draft", "failed"].includes(latest.status)) {
        throw new Error("草稿已经更新，请核对最新内容后重新预览。");
      }
      const content = formatNoteDraft(latest);
      if (content.length > 20000) throw new Error("创建笔记的完整内容（含来源）超过 20,000 字，请精简正文或拆成多份草稿后再创建。");
      setPreview({content, version: saved.version, key: crypto.randomUUID()});
    } catch (caught) {
      setError(messageOf(caught));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!preview || busy || disabled || locked || dirty || workspace.version !== preview.version) return;
    setBusy(true);
    setError("");
    try {
      onUpdate(await api.publishNoteDraft(workspace.id, draft.id, preview.version, preview.key));
      setPreview(null);
    } catch (caught) {
      setError(messageOf(caught));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return <section className="note-draft-editor" aria-label="新笔记草稿">
    <header className="note-draft-header">
      <div><h3>新笔记草稿</h3><p className="scope-notice">基于当前笔记继续写作，保存后可以创建为一条独立的 flomo 笔记。</p></div>
      <span className="note-draft-status" role="status">{draft.status === "publishing" && <Loader2 size={13} className="spin"/>}{statusLabels[draft.status]}</span>
    </header>

    {locked ? <>
      {draft.status === "published" ? <p className="selected-label"><Check size={14}/>已创建为新的 flomo 笔记。</p> : <p className="notice">{draft.status === "publishing" ? "正在等待 flomo 返回创建结果，请勿重复提交。" : "创建请求可能已到达 flomo。请先在 flomo 核对，工作台已停止重复创建。"}</p>}
      {draft.status === "published" && draft.resultMemo && sourceUrl(draft.resultMemo.url) && <a className="text-link" href={sourceUrl(draft.resultMemo.url)} target="_blank" rel="noopener noreferrer">查看新笔记<ArrowUpRight size={14}/></a>}
      <div className="apply-preview">{renderContent(formatNoteDraft(draft))}</div>
      {dirty && <div className="notice">
        <p>本地还有未提交的编辑，已为你保留。请核对创建结果，再决定是否清除。</p>
        <details><summary>查看未提交的本地编辑</summary><label>本地标题<input value={input.title} readOnly/></label><label>本地正文<textarea value={input.content} rows={8} readOnly/></label></details>
        <button className="text-button subdued" disabled={busy} onClick={reset}>清除未提交的本地编辑</button>
      </div>}
    </> : <>
      <div className="analysis-form">
        <label>新笔记标题<input aria-label="新笔记标题" value={input.title} maxLength={200} readOnly={busy} onChange={event => change({title: event.target.value})} placeholder="给这条新想法起个标题"/></label>
        <label>新笔记正文<textarea aria-label="新笔记正文" value={input.content} maxLength={100000} rows={16} readOnly={busy} onChange={event => change({content: event.target.value})} placeholder="写下基于当前笔记形成的新判断、补充或完整文章…"/></label>
      </div>
      {dirty && remoteChanged && <div className="notice">
        <p>另一端修改了这份草稿，你的输入已保留。以下是最新保存的内容：</p>
        <div className="apply-preview">{renderContent(formatNoteDraft(draft))}</div>
        <div className="inline-actions"><button className="text-button" disabled={busy} onClick={reset}>采用另一端内容</button><button className="text-button" disabled={busy} onClick={() => setEditing({...editing, baseline: inputOf(draft)})}>已核对，继续编辑我的版本</button></div>
      </div>}
      {publishLength > 20000 && <p className="scope-notice">当前完整内容（含来源）超过 20,000 字。可以保存草稿，创建笔记前请精简或拆分。</p>}
      <div className="analysis-actions">
        {dirty && <button className="text-button subdued" disabled={busy} onClick={reset}>放弃本次编辑</button>}
        <button className="button secondary small" disabled={disabled || busy || !dirty || remoteChanged} onClick={() => void save()}>{busy ? <Loader2 size={14} className="spin"/> : <Save size={14}/>}保存草稿</button>
        <button className="button primary small" disabled={disabled || busy || dirty || remoteChanged || !hasText || publishLength > 20000} onClick={() => void preparePreview()}>预览创建新笔记</button>
      </div>
      <p className="scope-notice" role="status">{dirty ? "有未保存的编辑，请先保存草稿。" : "草稿已保存。核对完整预览后，可创建新笔记。"}</p>
    </>}

    <details className="note-draft-sources analysis-sources">
      <summary>关联来源 · {draft.sources.length} 份</summary>
      <p className="scope-notice">来源在创建草稿时保留，创建新笔记时会一并附上。</p>
      <ul>{draft.sources.map(source => <li key={source.key}>{sourceUrl(source.url) ? <a href={sourceUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.title || source.id}<ArrowUpRight size={12}/></a> : <span>{source.title || source.id}</span>}<span className="scope-notice"> · {source.kind === "collector" ? "收藏原文" : "flomo 笔记"}</span></li>)}</ul>
    </details>
    {error && <p className="error-box" role="alert">{error}</p>}
    {draft.error && <p className="error-box" role="alert">{draft.error}</p>}

    {preview && <Modal title="确认创建新笔记" onClose={() => { if (!busy) setPreview(null); }} wide>
      <p className="modal-description">以下完整内容将创建为一条新的 flomo 笔记，包含标题、正文和关联来源。</p>
      <div className="apply-preview">{renderContent(preview.content)}</div>
      {workspace.version !== preview.version && <p className="notice">工作区已更新，请返回并重新预览最新内容。</p>}
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setPreview(null)}>返回核对</button><button className="button primary" disabled={disabled || busy || locked || dirty || workspace.version !== preview.version} onClick={() => void publish()}>{busy ? <Loader2 size={14} className="spin"/> : <ArrowUpRight size={14}/>}确认创建新笔记</button></div>
    </Modal>}
  </section>;
}
