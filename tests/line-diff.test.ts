import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffContext } from "../web/src/line-diff.js";

test("line comparison isolates edits and preserves nearby context", () => {
  const lines = diffLines("标题\n旧段落\n中间\n旧结尾", "标题\n新段落\n中间\n新结尾");
  assert.deepEqual(lines.map(line => line.kind), ["same", "removed", "added", "same", "removed", "added"]);
});

test("line comparisons retain exact content including empty lines and trailing newline", () => {
  for (const [before, after] of [["", "hello"], ["a\n", "a"], ["a\n\nb", "a\nb\n"], ["相同", "相同"]]) {
    const lines = diffLines(before!, after!);
    assert.equal(lines.filter(line => line.kind !== "added").map(line => line.text).join("\n"), before);
    assert.equal(lines.filter(line => line.kind !== "removed").map(line => line.text).join("\n"), after);
  }
});

test("very large replacements use a bounded comparison and retain every changed line", () => {
  const before = Array.from({ length: 5000 }, (_, i) => `旧${i}`).join("\n");
  const after = Array.from({ length: 5000 }, (_, i) => `新${i}`).join("\n");
  const lines = diffLines(before, after);
  assert.equal(lines.length, 10000);
  assert.equal(lines.filter(line => line.kind === "removed").map(line => line.text).join("\n"), before);
  assert.equal(lines.filter(line => line.kind === "added").map(line => line.text).join("\n"), after);
});

test("context folding never hides an addition or deletion", () => {
  const before = Array.from({ length: 80 }, (_, i) => `${i}`).join("\n");
  const after = before.replace("\n40\n", "\n新的第40行\n");
  const folded = diffContext(diffLines(before, after));
  assert.equal(folded.filter(line => line.kind === "omitted").length, 2);
  assert.deepEqual(folded.filter(line => line.kind === "added" || line.kind === "removed"), [
    { kind: "removed", text: "40" }, { kind: "added", text: "新的第40行" },
  ]);
});
