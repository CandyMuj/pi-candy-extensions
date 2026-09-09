import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { collectUserMessages, resolveTargetSnapshot, runRedo, runUndo } from "../src/commands.ts";
import { UndoSession } from "../src/session.ts";
import type { Snapshot } from "../src/types.ts";
import {
  FakeSession,
  makeConfig,
  makeTempDir,
  removeTempDir,
  selectCancel,
  selectContaining,
  selectStartsWith,
  writeTextFile,
} from "./helpers.ts";

interface Harness {
  root: string;
  workspace: string;
  fake: FakeSession;
  session: UndoSession;
}

async function makeHarness(): Promise<Harness> {
  const root = await makeTempDir();
  const workspace = path.join(root, "workspace");
  await writeTextFile(path.join(workspace, ".keep"), "");
  const fake = new FakeSession({ cwd: workspace });
  const session = UndoSession.create({
    api: fake.api,
    config: makeConfig({ storageDir: path.join(root, "storage") }),
    sleep: async () => {},
  });
  await session.start({ reason: "startup" });
  return { root, workspace, fake, session };
}

/** Simulate one agent operation: prompt -> snapshot -> edit -> bind. */
async function runOperation(
  h: Harness,
  options: { id: string; prompt: string; file: string; after: string },
): Promise<void> {
  h.session.onInput(options.prompt, "interactive", undefined);
  await h.session.onBeforeAgentStart(options.prompt);
  h.fake.pushUserMessage(options.id, options.prompt);
  await h.session.onToolCall("write", { path: options.file, content: options.after });
  await writeTextFile(path.join(h.workspace, options.file), options.after);
  h.fake.pushAssistant(`a-${options.id}`);
  h.session.onTurnEnd();
  await h.session.onAgentSettled();
}

async function content(h: Harness, file: string): Promise<string> {
  return await readFile(path.join(h.workspace, file), "utf8");
}

test("collectUserMessages returns user prompts newest first with a limit", () => {
  const branch = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "ok" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "second" }] } },
  ];
  const messages = collectUserMessages(branch, 10);
  assert.deepEqual(messages.map((message) => message.entry.id), ["u2", "u1"]);
  assert.deepEqual(messages.map((message) => message.text), ["second", "first"]);
  assert.equal(collectUserMessages(branch, 1).length, 1);
});

test("resolveTargetSnapshot prefers bound, then nearest earlier, then baseline", () => {
  const branch = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "a" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "b" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "c" } },
  ];
  const baseline: Snapshot = { id: "b", key: "baseline", kind: "baseline", createdAt: "", files: {} };
  const op1: Snapshot = { id: "s1", key: "u1", kind: "operation", createdAt: "", files: {} };
  const op2: Snapshot = { id: "s2", key: "u2", kind: "operation", createdAt: "", files: {} };

  assert.equal(resolveTargetSnapshot([baseline, op1, op2], branch, "u2")?.id, "s2");
  assert.equal(resolveTargetSnapshot([baseline, op1], branch, "u2")?.id, "s1");
  assert.equal(resolveTargetSnapshot([baseline], branch, "u2")?.id, "b");
  assert.equal(resolveTargetSnapshot([], branch, "u2"), undefined);
});

test("undo restores the file to the state before the selected message", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });
    await runOperation(h, { id: "u2", prompt: "second", file: "a.txt", after: "v2" });
    assert.equal(await content(h, "a.txt"), "v2");
    assert.deepEqual(h.session.store.state.trackedFiles, ["a.txt"]);

    h.fake.queueSelect(selectContaining("second"));
    h.fake.queueSelect(selectStartsWith("Restore code ("));
    await runUndo(h.session, h.fake.api);

    assert.equal(await content(h, "a.txt"), "v1", "op2 changes are reverted");
    assert.equal(h.fake.navigations.length, 0, "code-only undo does not navigate");
    assert.equal(h.session.store.state.redo.length, 1);
    assert.equal(h.session.store.state.redo[0]?.type, "code");
    assert.match(h.fake.lastNotice()?.message ?? "", /1 file/);
  } finally {
    await removeTempDir(h.root);
  }
});

test("undo to the first message falls back to the original content", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });
    await runOperation(h, { id: "u2", prompt: "second", file: "a.txt", after: "v2" });

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectStartsWith("Restore code ("));
    await runUndo(h.session, h.fake.api);

    assert.equal(await content(h, "a.txt"), "v0");
  } finally {
    await removeTempDir(h.root);
  }
});

test("redo restores the pre-undo content", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });
    await runOperation(h, { id: "u2", prompt: "second", file: "a.txt", after: "v2" });

    h.fake.queueSelect(selectContaining("second"));
    h.fake.queueSelect(selectStartsWith("Restore code ("));
    await runUndo(h.session, h.fake.api);
    assert.equal(await content(h, "a.txt"), "v1");

    await runRedo(h.session, h.fake.api);
    assert.equal(await content(h, "a.txt"), "v2");
    assert.equal(h.session.store.state.redo.length, 0);
  } finally {
    await removeTempDir(h.root);
  }
});

test("conversation-only undo pushes a redo item that navigates back", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });

    const oldLeaf = h.fake.leafId;
    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectContaining("Restore conversation"));
    await runUndo(h.session, h.fake.api);

    assert.equal(h.fake.navigations.length, 1);
    assert.equal(h.fake.navigations[0]?.targetId, "u1");
    assert.equal(await content(h, "a.txt"), "v1", "files untouched in conversation-only mode");
    assert.equal(h.session.store.state.redo[0]?.type, "conversation");
    assert.equal(h.session.store.state.redo[0]?.oldLeafId, oldLeaf);

    await runRedo(h.session, h.fake.api);
    assert.equal(h.fake.navigations.length, 2);
    assert.equal(h.fake.navigations[1]?.targetId, oldLeaf);
  } finally {
    await removeTempDir(h.root);
  }
});

test("restore code and conversation performs both parts", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectContaining("Restore code and conversation"));
    await runUndo(h.session, h.fake.api);

    assert.equal(await content(h, "a.txt"), "v0");
    assert.equal(h.fake.navigations.length, 1);
    assert.equal(h.session.store.state.redo[0]?.type, "both");
  } finally {
    await removeTempDir(h.root);
  }
});

test("summarize with custom prompt forwards instructions", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectContaining("custom"));
    h.fake.queueInput("focus on tests");
    await runUndo(h.session, h.fake.api);

    assert.equal(h.fake.navigations[0]?.options.summarize, true);
    assert.equal(h.fake.navigations[0]?.options.customInstructions, "focus on tests");
  } finally {
    await removeTempDir(h.root);
  }
});

test("cancelling the picker or the menu changes nothing", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });

    h.fake.queueSelect(selectCancel());
    await runUndo(h.session, h.fake.api);
    assert.equal(await content(h, "a.txt"), "v1");

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectContaining("Never mind"));
    await runUndo(h.session, h.fake.api);
    assert.equal(await content(h, "a.txt"), "v1");
    assert.equal(h.session.store.state.redo.length, 0);
  } finally {
    await removeTempDir(h.root);
  }
});

test("a new real prompt clears the redo stack", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectStartsWith("Restore code ("));
    await runUndo(h.session, h.fake.api);
    assert.equal(h.session.store.state.redo.length, 1);

    h.session.onInput("a new prompt", "interactive", undefined);
    assert.equal(h.session.store.state.redo.length, 0);

    h.session.onInput("queued", "interactive", "steer");
    assert.equal(h.session.store.state.redo.length, 0);
  } finally {
    await removeTempDir(h.root);
  }
});

test("queued input stays inside the same operation", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    h.session.onInput("first", "interactive", undefined);
    await h.session.onBeforeAgentStart("first");
    h.fake.pushUserMessage("u1", "first");
    await h.session.onToolCall("write", { path: "a.txt", content: "v1" });
    await writeTextFile(path.join(h.workspace, "a.txt"), "v1");

    // Queued steering input must not start a new operation snapshot.
    h.session.onInput("also do X", "interactive", "steer");
    await h.session.onBeforeAgentStart("also do X");
    h.fake.pushUserMessage("u1b", "also do X");
    h.session.onTurnEnd();
    await h.session.onAgentSettled();

    const operations = h.session.store.state.snapshots.filter((snapshot) => snapshot.kind === "operation");
    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.key, "u1");
  } finally {
    await removeTempDir(h.root);
  }
});

test("slash commands do not create operation snapshots", async () => {
  const h = await makeHarness();
  try {
    h.session.onInput("/compact", "interactive", undefined);
    await h.session.onBeforeAgentStart("/compact");
    assert.equal(h.session.store.state.snapshots.filter((s) => s.kind === "operation").length, 0);
  } finally {
    await removeTempDir(h.root);
  }
});

test("restore failures abort the undo before navigation", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    await runOperation(h, { id: "u1", prompt: "first", file: "a.txt", after: "v1" });
    // Corrupt the target snapshot: point at a backup that does not exist.
    const snapshot = h.session.store.state.snapshots.at(-1);
    assert.ok(snapshot);
    snapshot.files["a.txt"] = { backupFileName: "missing@v9", version: 9, backupTime: "" };

    h.fake.queueSelect(selectContaining("first"));
    h.fake.queueSelect(selectContaining("Restore code and conversation"));
    await runUndo(h.session, h.fake.api);

    assert.equal(h.fake.navigations.length, 0, "navigation must not run after a failed restore");
    assert.match(h.fake.notices.map((notice) => notice.message).join("\n"), /failed/i);
    assert.equal(await content(h, "a.txt"), "v1");
  } finally {
    await removeTempDir(h.root);
  }
});

test("stale redo entries are discarded", async () => {
  const h = await makeHarness();
  try {
    h.session.store.state.redo.push({
      type: "both",
      restoreKey: "gone",
      oldLeafId: "gone-entry",
      createdAt: "",
    });
    await runRedo(h.session, h.fake.api);
    assert.equal(h.session.store.state.redo.length, 0);
    assert.match(h.fake.lastNotice()?.message ?? "", /invalid|no longer/i);
  } finally {
    await removeTempDir(h.root);
  }
});

test("nothing to undo or redo is reported", async () => {
  const h = await makeHarness();
  try {
    await runUndo(h.session, h.fake.api);
    assert.match(h.fake.lastNotice()?.message ?? "", /nothing to undo/i);
    await runRedo(h.session, h.fake.api);
    assert.match(h.fake.lastNotice()?.message ?? "", /nothing to redo/i);
  } finally {
    await removeTempDir(h.root);
  }
});

test("extension-injected input does not start an operation", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "v0");
    h.session.onInput("real prompt", "interactive", undefined);
    await h.session.onBeforeAgentStart("real prompt");
    h.fake.pushUserMessage("u1", "real prompt");
    h.session.onTurnEnd();
    await h.session.onAgentSettled();
    assert.equal(h.session.store.state.snapshots.filter((s) => s.kind === "operation").length, 1);

    // An extension injects a message and triggers a run.
    h.session.onInput("injected", "extension", undefined);
    await h.session.onBeforeAgentStart("injected");
    assert.equal(h.session.store.state.snapshots.filter((s) => s.kind === "operation").length, 1);
  } finally {
    await removeTempDir(h.root);
  }
});
