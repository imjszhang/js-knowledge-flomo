import test from 'node:test';
import assert from 'node:assert/strict';
import {importedDraft} from '../shared/draft-markdown.js';

test('flomo imported draft restores bold lists and URL punctuation',()=>{
  assert.equal(importedDraft(String.raw`\*\*标题\*\*

\- 原文 https://example.com/?share\_code=one\&utm\_psn=two`), '**标题**\n\n- 原文 https://example.com/?share_code=one&utm_psn=two');
});
test('draft import keeps code, paths, escaped backslashes and normal markdown',()=>{
  const content = '正常 **标题**\n\n`a\\_b`\n\n```js\nconst a = /\\w+\\*/;\n```\n\nC:\\Users\\name\n\n' + String.raw`literal \\_ and \\*`;
  assert.equal(importedDraft(content),content);
});
