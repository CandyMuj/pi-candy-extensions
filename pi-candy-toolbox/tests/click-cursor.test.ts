/**
 * tools/click-cursor.ts：监听器前置、历史重建、TUI 守卫、鼠标序列判定
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCtx, makeLogger, makePiStub, useTempAgentDir } from "./helpers.ts";

useTempAgentDir();
const { default: clickCursor, ensureFirst, handleMouseData, rebuildHistoryFromSession } = await import(
  "../extensions/tools/click-cursor.ts"
);

/* ── 纯函数 ─────────────────────────────────────────────────────── */

test("ensureFirst moves the handler to the front and is idempotent", () => {
  const a = () => undefined;
  const b = () => undefined;
  const tui: any = { inputListeners: new Set([a, b]) };

  ensureFirst(tui, b);
  assert.deepEqual([...tui.inputListeners], [b, a]);

  ensureFirst(tui, b);
  assert.deepEqual([...tui.inputListeners], [b, a], "重复调用不应改变顺序或重复插入");
});

test("ensureFirst tolerates empty or missing listener sets", () => {
  const handler = () => undefined;
  const empty: any = { inputListeners: new Set() };
  ensureFirst(empty, handler);
  assert.equal(empty.inputListeners.size, 0);

  assert.doesNotThrow(() => ensureFirst({} as any, handler));
  assert.doesNotThrow(() => ensureFirst(undefined as any, handler));
});

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

/* ── 鼠标序列判定 ───────────────────────────────────────────────── */

function makeEditor() {
  const editor: any = {
    state: { lines: ["hello world"], cursorLine: 0, cursorCol: 0 },
    lastWidth: 20,
    paddingX: 1,
    scrollOffset: 0,
    tui: { requestRender: () => {} },
    buildVisualLineMap: () => [{ logicalLine: 0, startCol: 0, length: 20 }],
    setCursorCol: (col: number) => {
      editor.state.cursorCol = col;
    },
  };
  return editor;
}

/** rect: x 0..40, y 2..8（textTop=3, textBottom=7） */
function makeTui(options: { withLayout?: boolean } = {}) {
  const editor = makeEditor();
  const container = { children: [editor] };
  const tui: any = { mode: "fullscreen", children: [container], requestRender: () => {} };
  if (options.withLayout !== false) {
    tui.currentLayout = {
      height: 20,
      root: {
        rect: { x: 0, y: 0, width: 40, height: 20 },
        children: [{ component: container, rect: { x: 0, y: 2, width: 40, height: 6 } }],
      },
    };
  }
  return { tui, editor };
}

test("handleMouseData ignores non-mouse data and non-fullscreen TUIs", () => {
  const { tui, editor } = makeTui();
  const log = makeLogger();

  assert.equal(handleMouseData("a", editor, tui, log.log), undefined);
  assert.equal(handleMouseData("\x1b[<0;4;4M", editor, { ...tui, mode: "regular" }, log.log), undefined);
  assert.equal(log.calls.length, 0);
});

test("handleMouseData passes presses through when no layout is available", () => {
  const { tui, editor } = makeTui({ withLayout: false });
  const log = makeLogger();

  assert.equal(handleMouseData("\x1b[<0;4;4M", editor, tui, log.log), undefined);
  assert.match(String(log.calls[0]?.[0] ?? ""), /未找到编辑器 rect/);
});

test("handleMouseData passes presses outside the editor rect", () => {
  const { tui, editor } = makeTui();
  const log = makeLogger();

  assert.equal(handleMouseData("\x1b[<0;4;20M", editor, tui, log.log), undefined);
  assert.match(String(log.calls[0]?.[0] ?? ""), /按下在编辑器外/);
});

test("click inside the editor consumes the release and moves the cursor", () => {
  const { tui, editor } = makeTui();
  const log = makeLogger();

  assert.equal(handleMouseData("\x1b[<0;4;4M", editor, tui, log.log), undefined, "按下应放行");
  assert.equal(handleMouseData("\x1b[<0;4;4m", editor, tui, log.log)?.consume, true, "释放应被消费");

  const messages = log.calls.map((args) => String(args[0])).join("\n");
  assert.match(messages, /按下（放行，待点击\/拖拽判定）/);
  assert.match(messages, /点击判定 x=3 y=3/);
  assert.match(messages, /光标定位: /);
  assert.equal(editor.state.cursorLine, 0);
});

test("drag cancels the pending click judgement", () => {
  const { tui, editor } = makeTui();
  const log = makeLogger();

  handleMouseData("\x1b[<0;4;4M", editor, tui, log.log); // 按下
  assert.equal(handleMouseData("\x1b[<32;6;4M", editor, tui, log.log), undefined, "拖拽应放行");
  assert.equal(handleMouseData("\x1b[<0;6;4m", editor, tui, log.log), undefined, "拖拽后的释放应放行");
});

/* ── 安装与模式守卫 ─────────────────────────────────────────────── */

function registerTool() {
  const stub = makePiStub();
  const log = makeLogger();
  clickCursor.register(stub.pi, { debug: true }, log.log);
  return { stub, log };
}

test("session_start installs only in TUI mode", () => {
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
  assert.deepEqual(tui.widgetKeys, ["click-cursor-borrow", "click-cursor-borrow"], "借用后立即归还 widget");
  assert.equal(tui.terminalHandlers.length, 1);
  assert.match(String(log.calls[0]?.[0] ?? ""), /已安装/);

  // 安装后重复 session_start：不重复借用
  start({ reason: "reload" }, tui.ctx);
  assert.equal(tui.widgetKeys.length, 2);

  stub.handlers.get("session_shutdown")?.[0]?.({}, tui.ctx); // 清掉轮询定时器，避免进程挂住
});
