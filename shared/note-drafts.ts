import type { NoteDraft } from './contracts.js';

/** The publication preview and flomo create request must contain the same source links. */
export function formatNoteDraft(draft: Pick<NoteDraft,'title'|'content'|'sources'>): string {
  const sources = [...new Map(draft.sources.map(source => [source.key,source])).values()];
  const references = sources.map(source => `${source.title.replace(/#/g,'＃').replace(/\s+/g,' ').trim()}\n${source.url}`).join('\n\n');
  return [draft.title.trim(),draft.content.trim(),references ? `参考来源：\n${references}` : ''].filter(Boolean).join('\n\n');
}
