import test from "node:test";
import assert from "node:assert/strict";
import type { Workspace } from "../shared/contracts.js";
import { DraftSession } from "../web/src/draft-session.js";

function workspace(version = 1, draft = "原始草稿"): Workspace {
  return {
    id: "workspace-1",
    title: "一次思考",
    memoId: "memo-1",
    draft,
    version,
    source: {
      id: "memo-1",
      content: "原笔记",
      url: "https://flomoapp.com/mine",
      tags: ["待编/想法"],
      created_at: "",
      updated_at: "",
      content_truncated: false,
      linked_memos: [],
    },
    remote: null,
    sourceChanged: false,
    materials: [],
    messages: [],
    createdAt: "",
    updatedAt: "",
    lastCheckedAt: "",
  };
}

function setup(initial = workspace(), holdExternalUpdates = false) {
  let remote = initial;
  const saves: { text: string; version: number }[] = [];
  const session = new DraftSession(initial, {
    save: async (_id, text, version) => {
      saves.push({ text, version });
      remote = { ...remote, draft: text, version: version + 1 };
      return remote;
    },
    read: async () => remote,
    onSaved: () => {},
    holdExternalUpdates,
  });
  return { session, saves };
}

test("a clean editor adopts external revisions; an edited editor retains its buffer", () => {
  const { session } = setup();
  session.receive(workspace(2, "CLI 的草稿"));
  assert.equal(session.getSnapshot().draft, "CLI 的草稿");
  session.edit("用户正在输入");
  session.receive(workspace(3, "CLI 再次更新"));
  assert.equal(session.getSnapshot().draft, "用户正在输入");
  assert.equal(session.getSnapshot().conflict?.draft, "CLI 再次更新");
  session.resolve("server");
  assert.equal(session.getSnapshot().draft, "CLI 再次更新");
  assert.equal(session.dirty, false);
});

test("metadata revisions preserve local edits and advance the next save version", async () => {
  const { session, saves } = setup();
  session.edit("本地输入");
  session.receive({
    ...workspace(2),
    messages: [
      {
        id: "message",
        role: "user",
        content: "补充材料",
        actor: "cli",
        createdAt: "",
      },
    ],
  });
  assert.equal(session.getSnapshot().draft, "本地输入");
  assert.equal(session.getSnapshot().conflict, null);
  await session.flush();
  assert.deepEqual(saves, [{ text: "本地输入", version: 2 }]);
});

test("keeping local text resolves conflict against the newest server version", async () => {
  const { session, saves } = setup();
  session.edit("合并后的文本");
  session.receive(workspace(4, "另一端文本"));
  await assert.rejects(session.flush(), /冲突/);
  assert.equal(saves.length, 0);
  session.resolve("local");
  await session.flush();
  assert.deepEqual(saves, [{ text: "合并后的文本", version: 4 }]);
  assert.equal(session.dirty, false);
});

test("typing and appending an AI answer during an in-flight save preserves all local input", async () => {
  let resolveFirst!: (value: Workspace) => void;
  const saves: { text: string; version: number }[] = [];
  const session = new DraftSession(workspace(), {
    save: async (_id, text, version) => {
      saves.push({ text, version });
      if (saves.length === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return workspace(version + 1, text);
    },
    read: async () => workspace(),
    onSaved: () => {},
  });
  session.edit("第一段");
  const pending = session.flush();
  session.edit("第一段，继续输入");
  session.append("AI 补充");
  resolveFirst(workspace(2, "第一段"));
  await pending;
  assert.equal(session.getSnapshot().draft, "第一段，继续输入\n\nAI 补充");
  assert.deepEqual(saves, [
    { text: "第一段", version: 1 },
    { text: "第一段，继续输入\n\nAI 补充", version: 2 },
  ]);
  assert.equal(session.dirty, false);
});

test("an external draft arriving during save is compared after acknowledgement", async () => {
  let resolveSave!: (value: Workspace) => void;
  const session = new DraftSession(workspace(), {
    save: () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    read: async () => workspace(),
    onSaved: () => {},
  });
  session.edit("正在保存");
  const pending = session.flush();
  session.edit("尚未保存的后续内容");
  session.receive(workspace(3, "CLI 改动"));
  resolveSave(workspace(2, "正在保存"));
  await assert.rejects(pending, /冲突/);
  assert.equal(session.getSnapshot().draft, "尚未保存的后续内容");
  assert.equal(session.getSnapshot().conflict?.version, 3);
});

test("409 fetches the conflicting draft and never loses the local text", async () => {
  const session = new DraftSession(workspace(), {
    save: async () => {
      throw Object.assign(new Error("版本冲突"), { status: 409 });
    },
    read: async () => workspace(2, "CLI 已保存"),
    onSaved: () => {},
  });
  session.edit("本地未保存");
  await assert.rejects(session.flush(), /版本冲突/);
  assert.equal(session.getSnapshot().draft, "本地未保存");
  assert.equal(session.getSnapshot().conflict?.draft, "CLI 已保存");
  assert.equal(session.getSnapshot().saving, false);
});

test("network failure keeps edits available for an explicit retry", async () => {
  let calls = 0;
  const session = new DraftSession(workspace(), {
    save: async (_id, text, version) => {
      calls++;
      if (calls === 1) throw new Error("离线");
      return workspace(version + 1, text);
    },
    read: async () => workspace(),
    onSaved: () => {},
  });
  session.edit("不能丢失的草稿");
  await assert.rejects(session.flush(), /离线/);
  assert.equal(session.dirty, true);
  assert.equal(session.getSnapshot().draft, "不能丢失的草稿");
  await session.flush();
  assert.equal(session.dirty, false);
  assert.equal(session.getSnapshot().acknowledged.version, 2);
});

test("out of order external responses cannot rewind acknowledged versions", () => {
  const { session } = setup();
  session.receive(workspace(5, "最新"));
  session.receive(workspace(3, "迟到的结果"));
  assert.equal(session.getSnapshot().draft, "最新");
  assert.equal(session.getSnapshot().acknowledged.version, 5);
});

test("companion editor keeps externally changed text pending until explicit review", async () => {
  const { session, saves } = setup(workspace(), true);
  session.receive(workspace(2, "Codex 已补充一段"));
  assert.equal(session.getSnapshot().draft, "原始草稿");
  assert.equal(session.getSnapshot().review?.draft, "Codex 已补充一段");
  assert.equal(session.dirty, false);
  await assert.rejects(session.flush(), /待查看/);
  assert.deepEqual(saves, []);
  session.acceptReview();
  assert.equal(session.getSnapshot().draft, "Codex 已补充一段");
  assert.equal(session.getSnapshot().review, null);
  assert.equal((await session.flush()).version, 2);
});

test("typing while review is pending promotes the remote version to a conflict", async () => {
  const { session, saves } = setup(workspace(), true);
  session.receive(workspace(2, "Codex 的修改"));
  session.edit("我继续写的内容");
  assert.equal(session.getSnapshot().review, null);
  assert.equal(session.getSnapshot().conflict?.version, 2);
  await assert.rejects(session.flush(), /冲突/);
  session.resolve("local");
  await session.flush();
  assert.deepEqual(saves, [{ text: "我继续写的内容", version: 2 }]);
});

test("late metadata cannot rewind pending review, and newer metadata updates its version", () => {
  const { session } = setup(workspace(), true);
  session.receive(workspace(3, "修改后的正文"));
  session.receive({ ...workspace(2), goal: "迟到的目标" });
  assert.equal(session.getSnapshot().review?.version, 3);
  assert.equal(session.getSnapshot().acknowledged.version, 1);
  session.receive({ ...workspace(4, "修改后的正文"), goal: "补充例子" });
  assert.equal(session.getSnapshot().review?.version, 4);
  assert.equal(session.getSnapshot().review?.goal, "补充例子");
  session.acceptReview();
  assert.equal(session.getSnapshot().acknowledged.version, 4);
});

test("undoing typing retains the pending external change for review", () => {
  const { session } = setup(workspace(), true);
  session.receive(workspace(2, "外部改动"));
  session.edit("临时输入");
  session.edit("原始草稿");
  assert.equal(session.getSnapshot().conflict, null);
  assert.equal(session.getSnapshot().review?.draft, "外部改动");
  assert.equal(session.dirty, false);
});

test("a clean save followed immediately by an external revision still requires review", async () => {
  let resolveSave!: (value: Workspace) => void;
  const session = new DraftSession(workspace(), {
    holdExternalUpdates: true,
    save: () => new Promise(resolve => { resolveSave = resolve; }),
    read: async () => workspace(),
    onSaved: () => {},
  });
  session.edit("我的修改");
  const pending = session.flush();
  session.receive(workspace(3, "Codex 接着改"));
  resolveSave(workspace(2, "我的修改"));
  await assert.rejects(pending, /待查看/);
  assert.equal(session.getSnapshot().draft, "我的修改");
  assert.equal(session.getSnapshot().review?.version, 3);
  assert.equal(session.dirty, false);
});
