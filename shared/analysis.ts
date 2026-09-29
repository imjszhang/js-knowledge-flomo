import type { AnalysisCardInput, AnalysisKind, AnalysisRecord, AnalysisSource, Workspace } from './contracts.js';

export const analysisLabels: Record<AnalysisKind, string> = {
  insights:'发现主题', evolution:'梳理观点变化', connections:'寻找联系', outline:'组织文章', cards:'提炼候选卡片',
};

/** Only explicitly selected source snapshots are evidence. Drafts and chat are excluded. */
export function analysisSources(workspace: Workspace): AnalysisSource[] {
  const memos = [workspace.source, ...workspace.materials].map(memo => ({
    key:`flomo:${memo.id}`, kind:'flomo' as const, id:memo.id, url:memo.url,
    title:memo.content.split('\n').find(line => line.trim())?.slice(0,200) || '未命名笔记',
    content:memo.content, tags:memo.tags, createdAt:memo.created_at, updatedAt:memo.updated_at,
  }));
  const articles = (workspace.collectorMaterials ?? []).map(({article}) => ({
    key:`collector:${article.id}`, kind:'collector' as const, id:article.id, url:article.sourceUrl,
    title:article.title, content:article.content, tags:[], createdAt:'', updatedAt:article.updatedAt,
  }));
  return [...new Map([...memos,...articles].map(source => [source.key,source])).values()].sort((a,b) => a.key.localeCompare(b.key));
}

export function analysisFingerprint(workspace: Workspace): string {
  return JSON.stringify({goal:workspace.goal ?? '',sources:analysisSources(workspace)});
}

export function analysisIsStale(record: AnalysisRecord, workspace: Workspace): boolean {
  return JSON.stringify({goal:record.goal,sources:[...record.sources].sort((a,b) => a.key.localeCompare(b.key))}) !== analysisFingerprint(workspace);
}

/** The preview and remote write share this exact plain-text, flomo-compatible format. */
export function formatAnalysisCard(card: AnalysisCardInput, sources: AnalysisSource[]): string {
  const byKey = new Map(sources.map(source => [source.key,source]));
  const links = [...new Set(card.sourceKeys)].map(key => byKey.get(key)).filter((source): source is AnalysisSource => !!source);
  const tags = [...new Set(card.tags)].map(tag => `#${tag}`).join(' ');
  // Quoted source titles must not silently add their original flomo tags to the new card.
  const references = links.map(source => `${source.title.replace(/#/g,'＃').replace(/\s+/g,' ').trim()}\n${source.url}`).join('\n\n');
  return [card.title.trim(),card.body.trim(),tags,links.length ? `参考来源：\n${references}` : ''].filter(Boolean).join('\n\n');
}
