import type { Memo } from '../shared/contracts.js';
import type { LinkedMemoResolution } from '../shared/linked-memos.js';
import type { FlomoProvider } from './provider-types.js';
import { linkedMemoIds, memoLinksTo, validMemoId } from './memo-links.js';

const maxReads = 30;
const searchLimit = 50;
type Candidate = { id:string; outgoing:boolean; incoming:boolean };

/** Resolve one hop only. Reading associations never selects materials or changes a note. */
export async function resolveLinkedMemos(source:Memo, flomo:FlomoProvider):Promise<LinkedMemoResolution> {
  const warnings = new Set<string>();
  const candidates = new Map<string,Candidate>();
  let truncated = source.content_truncated;
  if (source.content_truncated) warnings.add('当前笔记正文不完整，关联列表可能有遗漏，请先刷新远端笔记。');
  for (const id of linkedMemoIds(source)) {
    if (id !== source.id) candidates.set(id,{id,outgoing:true,incoming:false});
  }
  try {
    const result = await flomo.search({query:source.id,limit:searchLimit});
    if (result.possiblyLimited || result.memos.length >= searchLimit) {
      truncated = true;
      warnings.add('反向关联搜索结果可能未全部返回，当前列表不是完整的关联清单。');
    }
    for (const memo of result.memos.slice(0,searchLimit)) {
      if (memo.id === source.id || !validMemoId(memo.id)) continue;
      const incoming = memoLinksTo(memo,source.id);
      // A truncated search preview may hide the actual link; only a full read can verify it.
      if (!incoming && !memo.content_truncated) continue;
      const existing = candidates.get(memo.id);
      if (existing) existing.incoming ||= incoming;
      else candidates.set(memo.id,{id:memo.id,outgoing:false,incoming});
    }
  } catch {
    truncated = true;
    warnings.add('暂时无法检查反向关联，当前仍可查看本笔记直接关联的笔记。');
  }
  const selected = [...candidates.values()].slice(0,maxReads);
  if (candidates.size > selected.length) {
    truncated = true;
    warnings.add(`每次最多读取 ${maxReads} 条关联笔记，部分关联尚未加载。`);
  }
  const items:LinkedMemoResolution['items'] = [];
  for (let offset = 0; offset < selected.length; offset += 4) {
    const batch = await Promise.all(selected.slice(offset,offset + 4).map(async (candidate):Promise<LinkedMemoResolution['items'][number] | null> => {
      const {id,outgoing,incoming} = candidate;
      let memo:Memo;
      try { memo = await flomo.get(id); }
      catch {
        if (!outgoing && !incoming) {
          truncated = true;
          warnings.add('部分搜索结果无法读取，尚未核实是否存在反向关联。');
          return null;
        }
        return {id,direction:outgoing ? 'outgoing' : 'incoming',status:'unavailable',message:'关联笔记暂时无法读取，可能已删除或授权不可用，请稍后重试。'};
      }
      let unavailable:string | undefined;
      if (memo.id !== id) unavailable = '返回的笔记与关联目标不一致，已隐藏该正文，请重试。';
      else if (memo.content_truncated || !memo.content.trim()) unavailable = '未能取得关联笔记的完整正文，请稍后重试。';
      else if (memo.content.length > 500_000) unavailable = '关联笔记正文过长，暂时无法在工作台展示。';
      if (unavailable) {
        if (!outgoing && !incoming) {
          truncated = true;
          warnings.add('部分搜索结果没有返回完整正文，尚未核实是否存在反向关联。');
          return null;
        }
        return {id,direction:outgoing ? 'outgoing' : 'incoming',status:'unavailable',message:unavailable};
      }
      const linksBack = memoLinksTo(memo,source.id);
      if (!outgoing && !linksBack) return null;
      return {id,direction:outgoing ? linksBack ? 'bidirectional' : 'outgoing' : 'incoming',status:'available',memo};
    }));
    items.push(...batch.filter((item):item is LinkedMemoResolution['items'][number] => item !== null));
  }
  return {items,truncated,checkedAt:new Date().toISOString(),warnings:[...warnings]};
}
