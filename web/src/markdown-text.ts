import { fromMarkdown } from 'mdast-util-from-markdown';

interface TextNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: TextNode[];
}

function visibleText(node: TextNode): string {
  if (node.type === 'html') return (node.value ?? '').replace(/<[^>]+>/g, '');
  if (node.type === 'definition') return '';
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return '\n';
  if (node.value !== undefined) return node.value;
  const separator = ['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? '\n' : '';
  return (node.children ?? []).map(visibleText).filter(Boolean).join(separator);
}

/** Display-only text: parse escapes before truncating, never strip literal URL/code characters. */
export function markdownExcerpt(content: string, length = 180): string {
  return visibleText(fromMarkdown(content)).trim().slice(0, length);
}
