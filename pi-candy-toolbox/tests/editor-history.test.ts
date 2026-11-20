/**
 * tools/editor-history.ts：历史重建、实例变化检测、TUI 守卫、安装生命周期
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCtx, makeLogger, makePiStub, useTempAgentDir } from "./helpers.ts";

useTempAgentDir();
const { default: editorHistory, rebuildHistoryFromSession, refreshEditorAndRebuild } = await import(
  "../extensions/tools/editor-history.ts"
);

/* ── 纯函数 ─────────────────────────────────────────────────────── */

test("rebuildHistoryFromSession keeps user messages, newest first, adjacent deduped", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "第一条" } },
    { type: "message", message: { role: "assistant", content: "回复" } },
    { type: "message", message: { role: "user", content: "第二条" } },
    { type: "message", message: { role: "user", content: "第二条" } },
    { type: "session_info", name: "标题" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "第三条" }] } },
  ];
  const editor = { history: ["会被替换"] };

  rebuildHistoryFromSession({ getEntries: () => entries }, editor);
  assert.deepEqual(editor.history, ["第三条", "第二条", "第一条"]);
});

test("rebuildHistoryFromSession caps history at 100 entries", () => {
  const entries = Array.from({ length: 120 }, (_, index) => ({
    type: "message",
    message: { role: "user", content: `msg${index}` },
  }));
  const editor = { history: [] as string[] };

  rebuildHistoryFromSession({ getEntries: () => entries }, editor);
  assert.equal(editor.history.length, 100);
  assert.equal(editor.history[0], "msg119");
  assert.equal(editor.history[99], "msg20");
});

test("rebuildHistoryFromSession ignores empty input", () => {
  const editor = { history: ["keep"] };
  rebuildHistoryFromSession(undefined, editor);
  assert.deepEqual(editor.history, ["keep"]);
  assert.doesNotThrow(() => rebuildHistoryFromSession({ getEntries: () => [] }, undefined));
});

/* ── 编辑器实例变化检测（轮询逻辑，同步可测） ───────────────── */

function makeEditorShape(history: string[] = []) {
  const editor: any = {
    history,
    state: { lines: ["x"], cursorLine: 0 },
    buildVisualLineMap: () => [],
    setCursorCol: () => {},
  };
  return editor;
}

function makeTuiWith(editor: unknown) {
  return { children: [{ children: [editor] }] };
}

test("refreshEditorAndRebuild rebuilds when the editor instance changed", () => {
  const oldEditor = makeEditorShape(["旧实例的历史"]);
  const newEditor = makeEditorShape([]);
  const session = { getEntries: () => [{ type: "message", message: { role: "user", content: "新会话的消息" } }] };
  const log = makeLogger();

  const result = refreshEditorAndRebuild(makeTuiWith(newEditor), oldEditor, session, log.log);

  assert.equal(result, newEditor, "应返回新实例");
  assert.deepEqual(newEditor.history, ["新会话的消息"], "新实例的历史被重建");
  assert.deepEqual(oldEditor.history, ["旧实例的历史"], "旧实例不被触碰");
  assert.match(String(log.calls[0]?.[0] ?? ""), /editor-changed/);
});

test("refreshEditorAndRebuild is a no-op when the instance is unchanged", () => {
  const editor = makeEditorShape(["旧"]);
  const session = { getEntries: () => [{ type: "message", message: { role: "user", content: "不应重建" } }] };
  const log = makeLogger();

  const result = refreshEditorAndRebuild(makeTuiWith(editor), editor, session, log.log);

  assert.equal(result, editor);
  assert.deepEqual(editor.history, ["旧"], "实例未变时不重建");
  assert.equal(log.calls.length, 0);
});

test("refreshEditorAndRebuild tolerates missing editor and session", () => {
  assert.doesNotThrow(() => refreshEditorAndRebuild({ children: [] }, undefined, undefined));
  assert.doesNotThrow(() => refreshEditorAndRebuild(undefined, undefined, { getEntries: () => [] }));
});

/* ── 安装与模式守卫 ─────────────────────────────────────────────── */

function registerTool() {
  const stub = makePiStub();
  const log = makeLogger();
  editorHistory.register(stub.pi, { debug: true }, log.log);
  return { stub, log };
}

test("session_start installs only in TUI mode and does not register input listeners", () => {
  const { stub, log } = registerTool();
  const start = stub.handlers.get("session_start")?.[0];
  assert.ok(start);

  const headless = makeCtx({ mode: "print" });
  start({ reason: "startup" }, headless.ctx);
  assert.deepEqual(headless.widgetKeys, [], "headless 下不应借用 widget");
  assert.equal(headless.terminalHandlers.length, 0);
  assert.equal(log.calls.length, 0);

  const tui = makeCtx({ mode: "tui" });
  start({ reason: "startup" }, tui.ctx);
  assert.deepEqual(tui.widgetKeys, ["editor-history-borrow", "editor-history-borrow"], "借用后立即归还 widget");
  assert.equal(tui.terminalHandlers.length, 0, "本工具不注册输入监听器（点击定位已退役）");
  assert.match(String(log.calls[0]?.[0] ?? ""), /已安装/);

  // 安装后重复 session_start：不重复借用
  start({ reason: "reload" }, tui.ctx);
  assert.equal(tui.widgetKeys.length, 2);

  stub.handlers.get("session_shutdown")?.[0]?.({}, tui.ctx); // 清掉轮询定时器，避免进程挂住
});

test("history is rebuilt on session rebuild reasons, untouched on startup", () => {
  const stub = makePiStub();
  const log = makeLogger();
  editorHistory.register(stub.pi, { debug: true }, log.log);
  const start = stub.handlers.get("session_start")?.[0];
  const shutdown = stub.handlers.get("session_shutdown")?.[0];
  assert.ok(start);

  // findCurrentEditor 需要 buildVisualLineMap / setCursorCol / state 三个形状
  const editor = makeEditorShape(["旧会话的历史"]);
  const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const run = (reason: string, entries: unknown[]) => start({ reason }, makeCtx({ mode: "tui", editor, entries }).ctx);

  run("startup", [user("启动会话的消息")]);
  assert.deepEqual(editor.history, ["旧会话的历史"], "startup 不干预 pi 自身的 populate");

  run("resume", [user("恢复的消息A"), user("恢复的消息B")]);
  assert.deepEqual(editor.history, ["恢复的消息B", "恢复的消息A"], "resume 按当前会话重建");

  run("new", []);
  assert.deepEqual(editor.history, [], "空会话应清空历史");

  run("fork", [user("分支的消息")]);
  assert.deepEqual(editor.history, ["分支的消息"], "fork 同样重建");

  run("reload", [user("重载后的消息")]);
  assert.deepEqual(editor.history, ["重载后的消息"], "reload 仍重建");

  shutdown?.({}, makeCtx({ mode: "tui" }).ctx); // 清掉轮询定时器，避免进程挂住
});
