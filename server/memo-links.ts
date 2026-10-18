import type { Memo } from '../shared/contracts.js';

export const validMemoId = (id:string):boolean => /^[A-Za-z0-9_-]{1,500}$/.test(id);

/** Only canonical flomo URLs or provider-confirmed IDs count; a bare ID is not a link. */
export function linkedMemoIds(memo:Memo):string[] {
  const ids = new Set(memo.linked_memos.filter(validMemoId));
  const content = memo.content.replace(/\\([_&])/g,'$1').replace(/&amp;/g,'&');
  for (const candidate of content.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[)\]。，,；;]+$/g,''));
      const id = url.searchParams.get('memo_id');
      if (url.protocol === 'https:' && url.hostname === 'v.flomoapp.com' && !url.port && !url.username && !url.password &&
        url.pathname === '/mine/' && url.searchParams.getAll('memo_id').length === 1 && id && validMemoId(id)) ids.add(id);
    } catch { /* Non-URLs and lookalike domains are not associations. */ }
  }
  return [...ids];
}

export function memoLinksTo(memo:Memo, id:string):boolean {
  return linkedMemoIds(memo).includes(id);
}
