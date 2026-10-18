import {fromMarkdown} from 'mdast-util-from-markdown';

/** Remove flomo's prose escapes only on import, never on user edits or code. */
export function importedDraft(content: string): string {
  const edits: {start:number; end:number; text:string}[] = [];
  function visit(node: {type:string; position?:{start:{offset?:number};end:{offset?:number}}; children?:unknown[]}) {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset as number;
      const end = node.position.end.offset as number;
      // Consume escaped backslashes together so paths and literal backslashes survive.
      const text = content.slice(start,end).replace(/\\(\\|[*_&-])/g,(match,character:string) => character === '\\' ? match : character);
      edits.push({start,end,text});
    }
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(fromMarkdown(content));
  for (const edit of edits.reverse()) content = content.slice(0,edit.start) + edit.text + content.slice(edit.end);
  return content;
}
