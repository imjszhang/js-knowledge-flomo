import test from "node:test";
import assert from "node:assert/strict";
import type { DiscussionContext, Job, Message } from "../shared/contracts.js";
import { confirmedDiscussionJob, conversationRounds, prepareDiscussionRequest, promptAfterConfirmation, type PendingDiscussionRequest } from "../web/src/discussion-state.js";

const context: DiscussionContext = { workspaceVersion: 4, capturedAt: "2026-10-14T01:00:00Z", fingerprint: "source-content", sources: [] };
const pending: PendingDiscussionRequest = { prompt: "重新核对", version: 4, key: "request-1", kind: "update" };
const job: Job = { id: "job-1", workspaceId: "workspace-1", kind: "ai", status: "succeeded", actor: "web", text: "回答", error: null, createdAt: "2026-10-14T01:00:00Z", updatedAt: "2026-10-14T01:00:01Z", idempotencyKey: "request-1", baseVersion: 4 };
function message(id: string, role: Message["role"], captured?: DiscussionContext): Message {
  return { id, role, content: id, createdAt: "2026-10-14T01:00:00Z", actor: "web", ...(captured ? { discussionContext: captured } : {}) };
}

test("restoring an unconfirmed request keeps its exact payload without flushing or refreshing", async () => {
  let prepared = 0;
  let keys = 0;
  const restored = JSON.parse(JSON.stringify(pending));
  const result = await prepareDiscussionRequest(restored, "用户已换成新问题", "question", async () => { prepared++; throw new Error("draft conflict"); }, () => `key-${++keys}`);
  assert.deepEqual(result, pending);
  assert.equal(prepared, 0);
  assert.equal(keys, 0);
});

test("a job received through the shared feed confirms a lost response; the next update gets a new version and key", async () => {
  assert.equal(confirmedDiscussionJob(pending, [job], "workspace-1"), job);
  assert.equal(confirmedDiscussionJob(pending, [{ ...job, kind: "publish" }], "workspace-1"), undefined);
  assert.equal(confirmedDiscussionJob(pending, [job], "another-workspace"), undefined);
  assert.equal(confirmedDiscussionJob(pending, [{ ...job, idempotencyKey: "other" }], "workspace-1"), undefined);
  const next = await prepareDiscussionRequest(null, pending.prompt, "update", async () => 12, () => "request-2");
  assert.equal(next.version, 12);
  assert.equal(next.key, "request-2");
});

test("confirmation only clears the exact submitted question and preserves separately composed input", () => {
  assert.equal(promptAfterConfirmation("想补充的新内容", pending), "想补充的新内容");
  const question = { ...pending, kind: "question" as const };
  assert.equal(promptAfterConfirmation("  重新核对  ", question), "");
  assert.equal(promptAfterConfirmation("新的问题", question), "新的问题");
});

test("answers match their captured question after another thought arrives, and the completed round is shown latest", () => {
  const question = message("Q1", "user", context);
  const thought = message("Q2", "user");
  const answer = message("A1", "assistant", context);
  assert.deepEqual(conversationRounds([question, thought, answer]).map(round => round.map(item => item.id)), [["Q2"], ["Q1", "A1"]]);
});

test("streaming output remains with its original question while other thoughts are saved", () => {
  assert.deepEqual(conversationRounds([message("Q1", "user", context), message("Q2", "user")], context).map(round => round.map(item => item.id)), [["Q2"], ["Q1"]]);
});

test("legacy answers stay in chronological rounds; unmatched captured answers do not attach to unrelated questions", () => {
  assert.deepEqual(conversationRounds([message("old-question", "user"), message("old-answer", "assistant")]).map(round => round.map(item => item.id)), [["old-question", "old-answer"]]);
  assert.deepEqual(conversationRounds([message("other-question", "user"), message("new-answer", "assistant", context)]).map(round => round.map(item => item.id)), [["other-question"], ["new-answer"]]);
});
