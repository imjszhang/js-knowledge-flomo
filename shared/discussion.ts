import type { DiscussionContext, DiscussionSource, Workspace } from './contracts.js';

/** Keep the input sent to AI and the comparison used by every client in one place. */
export function discussionInput(workspace: Workspace) {
  const source = workspace.remote ?? workspace.source;
  const memos = [...new Map([source,...workspace.materials.filter(memo => memo.id !== source.id)].map(memo => [memo.id,memo])).values()];
  const sourceData = memos.map(memo => ({
    kind:'flomo' as const,id:memo.id,url:memo.url,content:memo.content,tags:[...memo.tags].sort(),
    created_at:memo.created_at,updated_at:memo.updated_at,contentTruncated:memo.content_truncated,
  })).sort((a,b) => a.id.localeCompare(b.id));
  const collectorData = (workspace.collectorMaterials ?? []).map(({article,memoIds}) => ({
    kind:'collector' as const,id:article.id,title:article.title,url:article.sourceUrl,
    content:article.content,summary:article.summary,digest:article.digest,
    updatedAt:article.updatedAt,memoIds:[...memoIds].sort(),contentTruncated:article.contentTruncated,
  })).sort((a,b) => a.id.localeCompare(b.id));
  return {
    sourceMemoId:workspace.memoId,goal:workspace.goal ?? '',draft:workspace.draft,
    materials:[...sourceData,...collectorData],
    selectedMaterialReasons:(workspace.materialCandidates ?? [])
      .filter(candidate => candidate.status === 'selected' && workspace.materials.some(memo => memo.id === candidate.memo.id))
      .map(candidate => ({memoId:candidate.memo.id,reason:candidate.reason,relation:candidate.relation}))
      .sort((a,b) => a.memoId.localeCompare(b.memoId)),
    decisions:(workspace.decisions ?? []).filter(decision => decision.answer !== null)
      .map(({question,answer}) => ({question,answer})).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

export function discussionSources(workspace: Workspace): DiscussionSource[] {
  return discussionInput(workspace).materials.map(source => ({
    key:`${source.kind}:${source.id}`,kind:source.kind,id:source.id,url:source.url,
    title:source.kind === 'collector' ? source.title : source.content.split('\n')
      .map(line => line.trim()).find(line => line && !/^(?:#[^\s#]+\s*)+$/.test(line))?.replace(/^\*+|\*+$/g,'').slice(0,200) || '未命名笔记',
    updatedAt:source.kind === 'collector' ? source.updatedAt : source.updated_at,
  }));
}

function fingerprint(workspace: Workspace): string {
  // A routine check or a provider timestamp change alone is not a change in evidence.
  return JSON.stringify(discussionInput(workspace),(key,value) =>
    ['created_at','updated_at','updatedAt'].includes(key) ? undefined : value);
}

export function discussionContext(workspace: Workspace): DiscussionContext {
  return {workspaceVersion:workspace.version,capturedAt:new Date().toISOString(),fingerprint:fingerprint(workspace),sources:discussionSources(workspace)};
}

export function discussionIsStale(context: DiscussionContext | undefined, workspace: Workspace): boolean {
  return !!context && context.fingerprint !== fingerprint(workspace);
}

export function discussionContextStatus(context: DiscussionContext | undefined, workspace: Workspace): 'current' | 'stale' | 'unknown' {
  return context ? discussionIsStale(context,workspace) ? 'stale' : 'current' : 'unknown';
}
