/**
 * tools/transcript-jump.ts：提问列表、组件树定位、命令与快捷键
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { makeCtx, makeLogger, makePiStub } from "./helpers.ts";

initTheme("dark"); // SelectList/getSelectListTheme 渲染需要已初始化的主题

const {
  default: transcriptJump,
  JumpDialog,
  findTranscriptContainers,
  formatRelativeTime,
  isSkillComponent,
  isUserMessageComponent,
  listPrompts,
  locatePromptRow,
  locateTarget,
  promptIdAtRow,
  renderHeight,
  scrollToRow,
  startsWithSkillBlock,
  transcriptGeometry,
  userIsLocatable,
} = await import("../extensions/tools/transcript-jump.ts");

const NOW = Date.now();

const u1 = { type: "message", id: "u1", timestamp: NOW - 5 * 60_000, message: { role: "user", content: [{ type: "text", text: "第一个问题" }] } };
const a1 = { type: "message", id: "a1", timestamp: NOW - 4 * 60_000, message: { role: "assistant", content: [{ type: "text", text: "回答一" }] } };
const u2 = { type: "message", id: "u2", timestamp: NOW - 3 * 60_000, message: { role: "user", content: [{ type: "text", text: "第二个问题" }] } };
const a2tool = {
  type: "message",
  id: "a2",
  timestamp: NOW - 2 * 60_000,
  message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }, { type: "text", text: "带工具的回复" }] },
};
const u3 = { type: "message", id: "u3", timestamp: NOW - 60_000, message: { role: "user", content: [{ type: "text", text: "第三个问题" }] } };
const ENTRIES = [u1, a1, u2, a2tool, u3];

const themeStub = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

/** 假组件 */
function userComponent(lines: string[]): unknown {
  return { text: "提问文本", rebuild: () => {}, render: () => lines };
}
function plainComponent(lines: string[]): unknown {
  return { render: () => lines };
}

/** 构造与 ENTRIES 对应的假转录结构（header 2 行 + resources 1 行 + chat 组件） */
function makeTui(options: { mode?: string; contentLines?: string[]; widths?: boolean; chatChildren?: unknown[]; scrollTop?: number } = {}) {
  const scrollCalls: number[] = [];
  const renders: number[] = [];
  const scrollView = {
    scrollTo: (row: number) => scrollCalls.push(row),
    getContentWidth: (width: number) => (options.widths === false ? width + 1 : width),
    scrollTop: options.scrollTop ?? 0,
  };
  const header = plainComponent(["", ""]);
  const resources = plainComponent([""]);
  const chat = {
    children:
      options.chatChildren ?? [
        userComponent(["", ""]), // u1
        plainComponent(["", "", ""]), // a1
        userComponent([""]), // u2
        plainComponent(["", "", "", ""]), // a2tool
        userComponent(["", ""]), // u3
      ],
  };
  const doc = { children: [header, resources, chat] };
  const lines = options.contentLines ?? Array.from({ length: 15 }, () => "");
  const tui: any = {
    mode: options.mode ?? "fullscreen",
    requestRender: () => renders.push(1),
    children: [doc],
    getPrimaryScrollView: () => scrollView,
    currentLayout: { root: { children: [{ children: [] }, { scrollView, rect: { width: 100 }, scrollContentLines: lines }] } },
  };
  return { tui, scrollCalls, renders, chat, doc };
}

function registerTool(config: { shortcut?: string; autoLocate?: boolean } = {}) {
  const stub = makePiStub();
  const log = makeLogger();
  transcriptJump.register(stub.pi, { shortcut: "alt+j", debug: false, autoLocate: true, ...config }, log.log);
  return { stub, log, command: stub.commands.get("candy-jump") };
}

/** 跑 handler 到 await custom，构造组件并完成选择 */
async function runPicker(ui: ReturnType<typeof makeCtx>, tui: any, selectValue?: string) {
  const { stub, command } = registerTool();
  const run = command?.handler("", ui.ctx);
  await Promise.resolve();
  const factory = ui.custom.factory;
  assert.ok(factory, "应调用 ui.custom");
  const component = factory(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  assert.equal(typeof (component as any)?.render, "function");
  ui.resolveCustom(selectValue === undefined ? null : { value: selectValue });
  await run;
  return stub;
}

/* ── 纯函数 ─────────────────────────────────────────────────────── */

test("userIsLocatable follows pi's skill-block rendering rule", () => {
  assert.equal(userIsLocatable(u1), true);
  assert.equal(userIsLocatable(a1), false, "助手消息不是提问");
  const skillUser = (remainder?: string) => ({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `<skill name="s" location="l">\ncontent\n</skill>${remainder ? `\n\n${remainder}` : ""}` }],
    },
  });
  assert.equal(userIsLocatable(skillUser()), false, "纯 skill 块没有用户组件");
  assert.equal(userIsLocatable(skillUser("剩余内容")), true, "skill 块 + 尾随正文有用户组件");
  assert.equal(startsWithSkillBlock(skillUser()), true);
  assert.equal(startsWithSkillBlock(skillUser("剩余内容")), true, "带尾随正文的 skill 块也渲染 skill 组件");
  assert.equal(startsWithSkillBlock(u1), false);
});

test("locateTarget picks kind and ordinal per prompt", () => {
  const skillUser = (remainder?: string) => ({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `<skill name="s" location="l">\ncontent\n</skill>${remainder ? `\n\n${remainder}` : ""}` }],
    },
  });
  const skillWithRest = { id: "skillA", ...skillUser("剩余内容") };
  const skillOnly = { id: "skillB", ...skillUser() };
  const mixed = [u1, skillWithRest, u2, skillOnly, u3];

  assert.deepEqual(locateTarget(mixed, "skillA"), { kind: "skill", ordinal: 0 });
  assert.deepEqual(locateTarget(mixed, "skillB"), { kind: "skill", ordinal: 1 }, "skill 序号按全部 skill 块消息计数");
  assert.deepEqual(locateTarget(mixed, "u1"), { kind: "user", ordinal: 0 });
  assert.deepEqual(locateTarget(mixed, "u2"), { kind: "user", ordinal: 2 }, "skill+正文 的用户组件也计入 user 序号（与组件遍历一致）");
  assert.deepEqual(locateTarget(mixed, "u3"), { kind: "user", ordinal: 3 });

  // 纯 skill 提问：走 skill 组件，不影响其后的 user 序号
  const withSkillOnly = [u1, skillOnly, u2, a2tool, u3];
  assert.deepEqual(locateTarget(withSkillOnly, "u2"), { kind: "user", ordinal: 1 });
  assert.deepEqual(locateTarget(withSkillOnly, "u3"), { kind: "user", ordinal: 2 });

  assert.equal(locateTarget(ENTRIES, "missing"), undefined);
  assert.equal(
    locateTarget([{ type: "message", id: "empty", message: { role: "user", content: "" } }], "empty"),
    undefined,
    "空文本提问不可定位",
  );
});

test("listPrompts lists non-empty user prompts newest first", () => {
  const prompts = listPrompts([u1, a1, u2, { type: "message", message: { role: "user", content: "" } }, a2tool, u3]);
  assert.deepEqual(
    prompts.map((p) => ({ index: p.index, entryId: p.entryId })),
    [
      { index: 3, entryId: "u3" },
      { index: 2, entryId: "u2" },
      { index: 1, entryId: "u1" },
    ],
    "最近的排前面；序号仍按会话顺序编号",
  );
});

test("listPrompts keeps the full preview on one line without fixed-length cuts", () => {
  const longText = "这是一段很长的提问内容 " + "内容".repeat(80) + " 🐛";
  const prompt = listPrompts([
    { type: "message", id: "long", timestamp: NOW, message: { role: "user", content: [{ type: "text", text: longText }] } },
  ])[0];
  assert.ok(prompt);
  assert.equal(prompt.text, longText, "未达宽度上限时保持完整内容（含 emoji）");
  assert.equal(prompt.text.includes("\n"), false, "已折叠为单行");
});

test("formatRelativeTime buckets by age", () => {
  assert.equal(formatRelativeTime(NOW - 1_000, NOW), "刚刚");
  assert.equal(formatRelativeTime(NOW - 5 * 60_000, NOW), "5 分钟前");
  assert.equal(formatRelativeTime(NOW - 3 * 3_600_000, NOW), "3 小时前");
  assert.equal(formatRelativeTime(NOW - 2 * 86_400_000, NOW), "2 天前");
  assert.match(formatRelativeTime(NOW - 30 * 86_400_000, NOW) ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(formatRelativeTime(0, NOW), "");
});

test("isUserMessageComponent requires text and rebuild", () => {
  assert.equal(isUserMessageComponent({ text: "x", rebuild: () => {} }), true);
  assert.equal(isUserMessageComponent({ rebuild: () => {} }), false);
  assert.equal(isUserMessageComponent({ text: "x" }), false);
  assert.equal(isUserMessageComponent(null), false);
});

test("isSkillComponent requires skillBlock and updateDisplay", () => {
  assert.equal(isSkillComponent({ skillBlock: { name: "x" }, updateDisplay: () => {} }), true);
  assert.equal(isSkillComponent({ skillBlock: null, updateDisplay: () => {} }), false);
  assert.equal(isSkillComponent({ skillBlock: { name: "x" } }), false);
  assert.equal(isSkillComponent({ updateDisplay: () => {} }), false);
  assert.equal(isSkillComponent(null), false);
});

test("renderHeight returns line count or undefined on failure", () => {
  assert.equal(renderHeight({ render: () => ["", ""] }, 80), 2);
  assert.equal(renderHeight({ render: () => [] }, 80), 0);
  assert.equal(renderHeight({ render: () => undefined }, 80), undefined);
  assert.equal(renderHeight({ render: () => { throw new Error("boom"); } }, 80), undefined);
  assert.equal(renderHeight({}, 80), undefined);
});

test("locatePromptRow accumulates heights up to the ordinal-th component", () => {
  const { doc, chat } = makeTui();
  // header 2 + resources 1 = 3 行；u1 从行 3 开始
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "user", ordinal: 0 }), 3);
  // u2：3 + u1(2) + a1(3) = 8
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "user", ordinal: 1 }), 8);
  // u3：8 + u2(1) + a2tool(4) = 13
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "user", ordinal: 2 }), 13);
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "user", ordinal: 3 }), undefined, "序号超出用户组件数");
  assert.equal(locatePromptRow(undefined, chat, 100, { kind: "user", ordinal: 0 }), undefined);
  assert.equal(locatePromptRow({ children: [] }, chat, 100, { kind: "user", ordinal: 0 }), undefined);
});

test("locatePromptRow locates skill components independently", () => {
  const skillComp = (lines: string[]) => ({ skillBlock: { name: "s" }, updateDisplay: () => {}, render: () => lines });
  const doc = { children: [plainComponent(["", ""]), { children: [userComponent(["", ""]), skillComp(["", ""]), plainComponent([""]), skillComp([""])] }] };
  const chat = doc.children[1] as { children?: unknown[] };
  // header 2 + u1(2) = 4 → 第一个 skill 从行 4 开始；再 + skill(2) + 中间(1) = 7 → 第二个 skill 行 7
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "skill", ordinal: 0 }), 4);
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "skill", ordinal: 1 }), 7);
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "skill", ordinal: 2 }), undefined);
});

test("locatePromptRow fails when a component cannot be rendered", () => {
  const doc = { children: [plainComponent(["", ""]), { children: [userComponent([""]), { render: () => { throw new Error("boom"); } }] }] };
  const chat = doc.children[1] as { children?: unknown[] };
  assert.equal(locatePromptRow(doc, chat, 100, { kind: "user", ordinal: 0 }), 2, "坏组件在目标之后不影响");
  const doc2 = { children: [plainComponent(["", ""]), { children: [{ render: () => { throw new Error("boom"); } }, userComponent([""])] }] };
  const chat2 = doc2.children[1] as { children?: unknown[] };
  assert.equal(locatePromptRow(doc2, chat2, 100, { kind: "user", ordinal: 0 }), undefined, "坏组件在目标之前则失败");
});

test("promptIdAtRow picks the prompt whose first row is at or above scrollTop", () => {
  // makeTui 默认行：u1=3，u2=8，u3=13
  const rows = { user: [3, 8, 13], skill: [] };
  assert.equal(promptIdAtRow(ENTRIES, rows, 0), undefined, "视口还在摘要区（顶部之前）");
  assert.equal(promptIdAtRow(ENTRIES, rows, 3), "u1");
  assert.equal(promptIdAtRow(ENTRIES, rows, 7), "u1", "两条提问之间归上方那条");
  assert.equal(promptIdAtRow(ENTRIES, rows, 8), "u2", "首行与 scrollTop 重合算命中");
  assert.equal(promptIdAtRow(ENTRIES, rows, 12), "u2");
  assert.equal(promptIdAtRow(ENTRIES, rows, 999), "u3", "滚到底选最后一条提问");
  assert.equal(promptIdAtRow(ENTRIES, rows, 0), undefined);
});

test("promptIdAtRow counts skill components independently", () => {
  const skillUser = (remainder?: string) => ({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `<skill name="s" location="l">\ncontent\n</skill>${remainder ? `\n\n${remainder}` : ""}` }],
    },
  });
  const skillWithRest = { id: "skillA", ...skillUser("剩余内容") };
  const skillOnly = { id: "skillB", ...skillUser() };
  const mixed = [u1, skillWithRest, u2, skillOnly, u3];
  // 渲染对应：user 组件（u1 行 3、skillWithRest 行 7、u2 行 10、u3 行 14）；skill 组件（skillWithRest 行 5、skillOnly 行 12）
  const rows = { user: [3, 7, 10, 14], skill: [5, 12] };
  assert.equal(promptIdAtRow(mixed, rows, 5), "skillA", "skill 提问锚定其 skill 组件行");
  assert.equal(promptIdAtRow(mixed, rows, 8), "skillA");
  assert.equal(promptIdAtRow(mixed, rows, 12), "skillB");
  assert.equal(promptIdAtRow(mixed, rows, 13), "skillB");
  assert.equal(promptIdAtRow(mixed, rows, 14), "u3");
});

test("transcriptGeometry returns current scrollTop", () => {
  const { tui } = makeTui({ scrollTop: 42 });
  const geom = transcriptGeometry(tui);
  assert.equal(geom.scrollTop, 42);
  const { tui: tui2 } = makeTui();
  assert.equal(transcriptGeometry(tui2).scrollTop, 0);
});

test("findTranscriptContainers finds doc and the last container as chat", () => {
  const { tui, doc, chat } = makeTui();
  const found = findTranscriptContainers(tui);
  assert.equal(found?.doc, doc);
  assert.equal(found?.chat, chat);
  assert.equal(findTranscriptContainers({ children: [] }), undefined);
  assert.equal(findTranscriptContainers({}), undefined);
});

test("transcriptGeometry reads lines and content width from the layout", () => {
  const { tui } = makeTui();
  const geo = transcriptGeometry(tui);
  assert.equal(geo.contentWidth, 100);
  assert.equal(geo.lines?.length, 15);
  assert.deepEqual(transcriptGeometry({}), {});
});

test("scrollToRow calls scrollTo and requests a render", () => {
  const { tui, scrollCalls, renders } = makeTui();
  assert.equal(scrollToRow(tui, 13), true);
  assert.deepEqual(scrollCalls, [13]);
  assert.equal(renders.length, 1);
  assert.equal(scrollToRow({} as any, 0), false);
});

/* ── 选择器交互 ─────────────────────────────────────────────────── */

test("JumpDialog pages with ←/→ and filters with typed text", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ value: `id-${index}`, label: `item-${index}`, description: "" }));
  const picked: string[] = [];
  const closed: number[] = [];

  const dialog = new JumpDialog("测试", items, themeStub, (item) => picked.push(item.value), () => closed.push(1));
  dialog.handleInput("\x1b[C"); // 右方向键 = 下一页（0 → 12）
  dialog.handleInput("\r"); // Enter 选中第 13 项
  assert.equal(picked[0], "id-12");

  const dialog2 = new JumpDialog("测试", items, themeStub, (item) => picked.push(item.value), () => closed.push(1));
  dialog2.handleInput("2");
  dialog2.handleInput("0");
  dialog2.handleInput("\r");
  assert.equal(picked[1], "id-20", "过滤后 Enter 选中第一个匹配项");

  dialog2.handleInput("\x1b"); // Esc 取消
  assert.equal(closed.length, 1);
});

/* ── 命令 / 快捷键集成 ──────────────────────────────────────────── */

test("openPicker notifies when the session has no prompts", async () => {
  const { command } = registerTool();
  const ui = makeCtx({ entries: [], mode: "tui" });
  await command?.handler("", ui.ctx);
  assert.deepEqual(ui.notices, [{ message: "会话里还没有提问", type: "info" }]);
  assert.equal(ui.custom.factory, undefined);
});

test("openPicker is a no-op outside the TUI", async () => {
  const { command } = registerTool();
  const ui = makeCtx({ entries: ENTRIES, mode: "print" });
  await command?.handler("", ui.ctx);
  assert.equal(ui.custom.factory, undefined);
});

test("selecting a rendered prompt scrolls to its exact component row", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls, renders } = makeTui();
  await runPicker(ui, tui, "u3");
  assert.deepEqual(scrollCalls, [13], "u3 首行 = header2 + resources1 + u1(2) + a1(3) + u2(1) + a2tool(4)");
  assert.equal(renders.length, 1);
  assert.deepEqual(ui.notices, []);
});

test("cancelling the picker does nothing", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls } = makeTui();
  await runPicker(ui, tui); // selectValue undefined → done(null)
  assert.deepEqual(scrollCalls, []);
  assert.deepEqual(ui.notices, []);
});

test("compacted prompts fall back to the top (summary)", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: [u3], mode: "tui" });
  const { tui, scrollCalls } = makeTui();
  await runPicker(ui, tui, "u1");
  assert.deepEqual(scrollCalls, [0]);
  assert.deepEqual(ui.notices, [{ message: "该提问已被压缩为摘要，已定位到会话顶部", type: "info" }]);
});

test("regular (inline) TUI cannot jump", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls } = makeTui({ mode: "regular" });
  await runPicker(ui, tui, "u3");
  assert.deepEqual(scrollCalls, []);
  assert.match(ui.notices[0]?.message ?? "", /仅支持 fullscreen/);
});

test("skill-block prompts all jump to their skill component row", async () => {
  const skillUser = (remainder?: string) => ({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `<skill name="s" location="l">\ncontent\n</skill>${remainder ? `\n\n${remainder}` : ""}` }],
    },
  });
  const skillWithRest = { ...skillUser("剩余内容"), id: "s1", timestamp: NOW - 2 * 60_000 };
  const skillOnly = { ...skillUser(), id: "s2", timestamp: NOW - 60_000 };
  const all = [skillWithRest, skillOnly];
  const ui = makeCtx({ entries: all, contextEntries: all, mode: "tui" });
  // chat：两个 skill 组件各 2 行；skill 组件首行：s1=3，s2=5
  const skillComp = { skillBlock: { name: "s" }, updateDisplay: () => {}, render: () => ["", ""] };
  const { tui, scrollCalls } = makeTui({ chatChildren: [skillComp, skillComp] });

  await runPicker(ui, tui, "s2");
  assert.deepEqual(scrollCalls, [5], "纯 skill 块跳到第二个 skill 组件");

  const ui2 = makeCtx({ entries: all, contextEntries: all, mode: "tui" });
  const { tui: tui2, scrollCalls: scrollCalls2 } = makeTui({ chatChildren: [skillComp, skillComp] });
  await runPicker(ui2, tui2, "s1");
  assert.deepEqual(scrollCalls2, [3], "带尾随正文的 skill 也跳到 skill 组件（与纯 skill 一致）");
});

test("out-of-bounds computed row refuses to jump", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls } = makeTui({ contentLines: ["只有一行"] });
  await runPicker(ui, tui, "u3");
  assert.deepEqual(scrollCalls, []);
  assert.match(ui.notices[0]?.message ?? "", /越界/);
});

test("off-branch prompts are excluded from the picker", async () => {
  const offBranch = {
    type: "message",
    id: "off",
    timestamp: NOW,
    message: { role: "user", content: [{ type: "text", text: "被切走的旧分支提问" }] },
  };
  const ui = makeCtx({ entries: [offBranch, ...ENTRIES], branchEntries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls } = makeTui();

  // 打开选择器：旧分支提问不应出现在列表里
  const { command } = registerTool();
  const run = command?.handler("", ui.ctx);
  await Promise.resolve();
  const component = ui.custom.factory?.(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  const rendered = (component as any)?.render?.(120)?.join("\n") ?? "";
  assert.doesNotMatch(rendered, /被切走的旧分支提问/, "旧分支提问不应展示");
  assert.match(rendered, /第三个问题/);

  // 即使强行选中旧分支 id（理论上不可能），也不滚动不报错
  ui.resolveCustom({ value: "off" });
  await run;
  assert.deepEqual(scrollCalls, []);
  assert.deepEqual(ui.notices, []);
});

test("branch prompts outside the rendered context are marked compacted", async () => {
  // u1 在当前分支但不在渲染集合（被压缩）→ 列表里标记「已压缩」，选中降级顶部
  const ui = makeCtx({ entries: ENTRIES, branchEntries: ENTRIES, contextEntries: [u2, a2tool, u3], mode: "tui" });
  const { command } = registerTool();
  const run = command?.handler("", ui.ctx);
  await Promise.resolve();
  const { tui } = makeTui();
  const component = ui.custom.factory?.(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  const rendered = (component as any)?.render?.(120)?.join("\n") ?? "";
  assert.match(rendered, /第一个问题[\s\S]*已压缩/);
  ui.resolveCustom({ value: "u1" });
  await run;
  assert.match(ui.notices[0]?.message ?? "", /已被压缩为摘要/);
});

test("shortcut is registered (configurable) and shares the picker", async () => {
  const { stub } = registerTool();
  assert.equal(stub.shortcuts.has("alt+j"), true);
  assert.match(stub.shortcuts.get("alt+j")?.description ?? "", /提问跳转/);

  const custom = registerTool({ shortcut: "alt+m" });
  assert.equal(custom.stub.shortcuts.has("alt+m"), true);
  assert.equal(custom.stub.shortcuts.has("alt+j"), false);

  // 快捷键 handler 与命令共用同一入口
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { tui, scrollCalls } = makeTui();
  const run = stub.shortcuts.get("alt+j")?.handler(ui.ctx);
  await Promise.resolve();
  const component = ui.custom.factory?.(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  assert.equal(typeof (component as any)?.render, "function");
  ui.resolveCustom({ value: "u2" });
  await run;
  assert.deepEqual(scrollCalls, [8], "u2 首行 = 3 + u1(2) + a1(3)");
});

test("autoLocate preselects the prompt near the current scroll position", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { command } = registerTool();
  const run = command?.handler("", ui.ctx);
  await Promise.resolve();
  // scrollTop = 8 → u2（列表倒序中 index 1）
  const { tui } = makeTui({ scrollTop: 8 });
  const component: any = ui.custom.factory?.(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  await new Promise((r) => setTimeout(r, 0)); // 等异步定位完成
  assert.equal(component.list.selectedIndex, 1, "自动选中视口附近的提问 u2");
  ui.resolveCustom(null);
  await run;
});

test("autoLocate off keeps default selection and skips traversal", async () => {
  const ui = makeCtx({ entries: ENTRIES, contextEntries: ENTRIES, mode: "tui" });
  const { command } = registerTool({ autoLocate: false });
  const run = command?.handler("", ui.ctx);
  await Promise.resolve();
  // chat 组件全部渲染失败：若做了组件遍历会得到 undefined，但 autoLocate 关闭时不应发生任何遍历
  const { tui } = makeTui({
    scrollTop: 8,
    chatChildren: [{ render: () => { throw new Error("boom"); } }],
  });
  const component: any = ui.custom.factory?.(tui, themeStub, {}, (value: any) => ui.resolveCustom(value));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(component.list.selectedIndex, 0, "保持默认选中最新");
  ui.resolveCustom(null);
  await run;
  assert.deepEqual(ui.notices, [], "无任何报错");
});
