import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownExcerpt } from '../web/src/markdown-text.js';

test('card excerpts decode Markdown escapes without deleting URL underscores, query parameters or fragments', () => {
  const url = 'https://example.com/article_name?share_code=test&utm_psn=123#part_one';
  const escaped = url.replace(/_/g, '\\_').replace(/&/g, '\\&');
  assert.equal(markdownExcerpt(`原文：${escaped}`,1000),`原文：${url}`);
  assert.equal(markdownExcerpt(url,1000),url);
  assert.equal(markdownExcerpt(`[${escaped}](${escaped})`,1000),url);
  assert.equal(markdownExcerpt(`<${url}>`,1000),url);
});

test('display text removes formatting but retains literal escaped punctuation and code', () => {
  assert.equal(markdownExcerpt('# 标题\n\n**重点**与*强调*\n\n- 第一条\n- 第二条'), '标题\n重点与强调\n第一条\n第二条');
  assert.equal(markdownExcerpt(String.raw`\*\*标题\*\*\n`), '**标题**\\n');
  assert.equal(markdownExcerpt('`share\\_code & C:\\tmp #tag`'), 'share\\_code & C:\\tmp #tag');
  assert.equal(markdownExcerpt('[可见文字](https://example.com/hidden "隐藏标题")'), '可见文字');
  assert.equal(markdownExcerpt('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(markdownExcerpt('<p>只显示文字</p>'), '只显示文字');
});

test('excerpt limits apply to decoded visible text, without changing source content', () => {
  const original = String.raw`ab\_cd\&ef`;
  assert.equal(markdownExcerpt(original,5),'ab_cd');
  assert.equal(original,String.raw`ab\_cd\&ef`);
});
