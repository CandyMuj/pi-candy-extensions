/**
 * transcript-jump — 全屏模式下跳转到任意一条历史提问
 *
 * 命令：/candy-jump（默认快捷键 alt+j，配置 shortcut 可改）
 *
 * 注意：Windows 终端会把 Ctrl+Shift+字母折叠成 Ctrl+字母（如 Ctrl+Shift+J = Ctrl+J = 插入换行），
 * 因此默认键位避开 Ctrl+Shift+字母组合。
 *
 * 选择器列出会话全部用户提问（序号 + 预览 + 相对时间），最近的排在前面，支持输入过滤与 ←/→ 翻页，
 * 样式与 pi 原生 select 一致（替换编辑器区域全宽渲染，非弹窗）。
 *
 * 定位机制（不依赖任何标记）：会话组件按顺序挂在 chatContainer 里，逐个渲染测高并累加，
 * 直接算出选中提问首行的精确行号并 scrollTo——与 pi 的 OSC133 标记无关，任何渲染环境一致；
 * 定位失败直接报错，不做猜测。
 *
 * 已知限制（详见 docs/transcript-jump.md）：
 *   - 仅 fullscreen 可跳（alt-screen 才有 ScrollView 与布局树）；regular/headless 不可用
 *   - /compact 后旧消息不再渲染：选择被压缩的提问时打开只读查看器（原文 + 助手回复），
 *     不滚动、不切换会话点；任何失败仅 notify 并停在当前
 *   - 依赖 tui.children 的结构与组件 render 测高（与 editor-history 同级内部 API 依赖），无回归保证
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  getAgentDir,
  getMarkdownTheme,
  getSelectListTheme,
  renderDiff,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type Focusable,
  Input,
  type KeyId,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  fuzzyMatch,
  getKeybindings,
  sliceByColumn,
  truncateToWidth,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import { entryText, isUserMessage, type EntryLike } from "../core/entries.ts";

export interface TranscriptJumpConfig {
  /** 调试日志开关：与插件级 $toolbox.debug 为「或」关系，任一为 true 即写 <logDir>/transcript-jump.log */
  debug: boolean;
  /** 打开提问列表的快捷键（KeyId 格式，见 pi keybindings 文档） */
  shortcut: string;
  /** 打开选择器时异步预选当前视口附近的提问（不阻塞打开）；关闭则始终默认选中最新，且不做任何组件遍历 */
  autoLocate: boolean;
  /** edit/write 的 diff 渲染方式：auto（宽则双栏窄则单栏）/ split（双栏）/ unified（单栏） */
  diffViewMode: "auto" | "split" | "unified";
}

/** 预览单行显示宽度上限（防超长消息占内存；正常提问远小于此，视觉截断交给 SelectList 按终端宽度做） */
const PREVIEW_MAX_WIDTH = 400;

// ── 局部最小类型（零额外依赖）──────────────────────────────────────
/** 渲染组件的最小形状（render 返回行数组） */
interface ComponentLike {
  render(width: number): string[] | undefined;
  [key: string]: unknown;
}

interface TuiLike {
  mode?: string;
  children?: Array<{ children?: unknown[] }>;
  currentLayout?: unknown;
  requestRender?: () => void;
  getPrimaryScrollView?: () =>
    | {
        scrollTo(row: number): void;
        getContentWidth?(width: number): number;
        scrollTop?: number;
      }
    | undefined;
}

interface PickerCtx {
  mode?: string;
  cwd?: string;
  sessionManager?: {
    getEntries(): unknown[];
    /** 当前分支（leaf 到根的祖先链，含压缩前缀；不含被 /tree 切走的旧分支） */
    getBranch?(): unknown[];
    buildContextEntries(): unknown[];
  };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(factory: (...args: any[]) => unknown, options?: unknown): Promise<T | undefined>;
  };
}

type ThemeLike = { fg: (name: string, text: string) => string; bold: (text: string) => string; bg?: (name: string, text: string) => string };

/** 横向分隔线（宽度自适应；颜色显式传入——jiti 模块缓存下全局主题可能失效） */
class BorderLine {
  private color: (text: string) => string;

  constructor(color: (text: string) => string) {
    this.color = color;
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

// ── 纯函数 ─────────────────────────────────────────────────────────

/** 与 pi 的 parseSkillBlock 同款正则：<skill> 块 + 可选尾随用户消息 */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** 用户消息是否渲染出用户组件（纯 skill 块只渲染 skill 组件，无用户组件可定位） */
function userRendersZone(text: string): boolean {
  const match = SKILL_BLOCK_RE.exec(text);
  if (!match) return text.length > 0;
  return Boolean(match[4]?.trim());
}

/** 用户提问是否有用户组件可定位（纯 skill 块提问渲染成 skill 组件，走另一条定位路径） */
export function userIsLocatable(e: EntryLike): boolean {
  if (!isUserMessage(e)) return false;
  return userRendersZone(entryText(e));
}

/** 用户消息是否以 skill 块开头（无论有无尾随正文，渲染时都会有 skill 组件） */
export function startsWithSkillBlock(e: EntryLike): boolean {
  if (!isUserMessage(e)) return false;
  const text = entryText(e).trim();
  return text ? SKILL_BLOCK_RE.test(text) : false;
}

/** 提问列表项 */
export interface PromptItem {
  entryId: string;
  /** 1-based 序号 */
  index: number;
  /** 单行预览（白空格折叠，用于列表展示） */
  text: string;
  timestamp: number;
}

export type DiffViewMode = "auto" | "split" | "unified";

/** auto 模式的宽度阈值：与 pi-tool-display 的 diffSplitMinWidth 默认值一致 */
export const SPLIT_MIN_WIDTH = 120;

/**
 * 样式安全复位：只复位前景/加粗/反色，不动背景。
 * 对含 ANSI 的行做截断/换行切段后，切点可能落在复位序列之前，残留反色/前景会污染行尾补齐空格
 * （反色残留 = 黑底白字）；在段尾追加它可杀掉泄漏样式且不破坏工具框背景（不能用 \x1b[0m，会连背景一起复位）。
 */
const ANSI_SAFE_RESET = "\x1b[39m\x1b[22m\x1b[27m";

/** 把字符串里的全量复位替换为背景安全的复位（truncateToWidth 的省略号自带 \x1b[0m，会连背景一起复位成黑底） */
function stripFullResets(text: string): string {
  return text.replace(/\x1b\[0m/g, ANSI_SAFE_RESET);
}

interface SplitRow {
  left: string;
  right: string;
  /** 整行（diff 头/位置头/空行） */
  full?: boolean;
}

/** 把 unified diff 文本解析为双栏行：- 归左、+ 归右、context 双栏、头部整行 */
export function parseSplitRows(diffText: string): SplitRow[] {
  const rows: SplitRow[] = [];
  const pendingLeft: string[] = [];
  const flush = (): void => {
    while (pendingLeft.length > 0) rows.push({ left: pendingLeft.shift() ?? "", right: "" });
  };
  const full = (line: string): void => {
    rows.push({ left: line, right: "", full: true });
  };
  for (const raw of diffText.split("\n")) {
    const ch = raw[0];
    if (
      raw === "" ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@") ||
      raw.startsWith("\\")
    ) {
      flush();
      full(raw);
      continue;
    }
    if (ch === "-") {
      pendingLeft.push(raw);
    } else if (ch === "+") {
      rows.push({ left: pendingLeft.shift() ?? "", right: raw });
    } else if (ch === " ") {
      flush();
      rows.push({ left: raw, right: raw });
    } else {
      flush();
      full(raw);
    }
  }
  flush();
  return rows;
}

/** 按显示宽度换行（ANSI 感知、无省略号；每段尾部追加背景安全的样式复位） */
function wrapToWidth(text: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = text;
  while (visibleWidth(remaining) > width) {
    lines.push(stripFullResets(sliceByColumn(remaining, 0, width)) + ANSI_SAFE_RESET);
    remaining = sliceByColumn(remaining, width, visibleWidth(remaining) - width);
  }
  lines.push(stripFullResets(remaining) + ANSI_SAFE_RESET);
  return lines;
}

/** 双栏 diff 渲染：左栏删减/上下文，右栏新增/上下文，按 hunk 配对对齐；长行换行（无省略号）；行级着色 */
export function renderSplitDiff(diffText: string, width: number, theme: { fg: (name: string, text: string) => string }): string[] {
  const w = Math.max(4, width);
  const leftW = Math.max(1, Math.floor((w - 1) / 2));
  const rightW = Math.max(1, w - 1 - leftW);
  const sep = theme.fg("dim", "│");
  const pad = (text: string, target: number): string => text + " ".repeat(Math.max(0, target - visibleWidth(text)));
  const color = (line: string): string => {
    if (!line) return "";
    const ch = line[0];
    if (ch === "-") return theme.fg("toolDiffRemoved", line);
    if (ch === "+") return theme.fg("toolDiffAdded", line);
    return theme.fg("dim", line);
  };
  return parseSplitRows(diffText).flatMap((row) => {
    if (row.full) return wrapToWidth(theme.fg("dim", row.left), w).map((line) => pad(line, w));
    const left = wrapToWidth(color(row.left), leftW);
    const right = wrapToWidth(color(row.right), rightW);
    const rows: string[] = [];
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) {
      rows.push(pad(left[i] ?? "", leftW) + sep + pad(right[i] ?? "", rightW));
    }
    return rows;
  });
}

/** edit/write 的 diff 视图组件：按宽度决定 split/unified（auto 模式） */
class DiffViewComponent {
  private readonly diffText: string;
  private readonly mode: DiffViewMode;
  private readonly theme: { fg: (name: string, text: string) => string };

  constructor(diffText: string, mode: DiffViewMode, theme: { fg: (name: string, text: string) => string }) {
    this.diffText = diffText;
    this.mode = mode;
    this.theme = theme;
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    const actual = this.mode === "auto" ? (width >= SPLIT_MIN_WIDTH ? "split" : "unified") : this.mode;
    if (actual === "split") return renderSplitDiff(this.diffText, width, this.theme);
    return renderDiff(this.diffText).split("\n");
  }
}

/** 归一化时间戳：ISO 字符串 → epoch ms */function toTimestamp(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 列出会话全部用户提问（含被压缩的；空文本提问没有渲染行，跳不了，直接不列）。最近的排在最前，序号仍按会话顺序编号 */
export function listPrompts(entries: EntryLike[]): PromptItem[] {
  const prompts: PromptItem[] = [];
  let index = 0;
  for (const e of entries) {
    if (!isUserMessage(e)) continue;
    const text = entryText(e).trim();
    if (!text) continue;
    index++;
    prompts.push({
      entryId: e.id ?? "",
      index,
      // 折叠成单行；只做显示宽度上限保护（不按固定字符数截断，行内容由 SelectList 按终端宽度截断并加省略号）
      text: truncateToWidth(text.replace(/\s+/g, " "), PREVIEW_MAX_WIDTH, "…"),
      timestamp: toTimestamp(e.timestamp),
    });
  }
  // 稳定排序：时间戳相同保持会话顺序
  prompts.sort((a, b) => b.timestamp - a.timestamp);
  return prompts;
}

export type LocateTarget = { kind: "skill" | "user"; ordinal: number };

/**
 * 目标提问的定位目标：skill 块开头 → skill 组件；否则 → 用户组件。
 * 两类序号独立累计（一条 skill+正文的消息会同时计入两边，与渲染出的两类组件分别一一对应）。
 * 目标不可定位（空文本等）或未找到时返回 undefined。
 */
export function locateTarget(entries: EntryLike[], entryId: string): LocateTarget | undefined {
  let skill = 0;
  let user = 0;
  for (const e of entries) {
    if (isUserMessage(e) && e.id === entryId) {
      if (startsWithSkillBlock(e)) return { kind: "skill", ordinal: skill };
      if (userIsLocatable(e)) return { kind: "user", ordinal: user };
      return undefined;
    }
    if (startsWithSkillBlock(e)) skill++;
    if (userIsLocatable(e)) user++;
  }
  return undefined;
}

/** pi 的 UserMessageComponent 形状：text + rebuild（助手组件没有这两个） */
export function isUserMessageComponent(component: unknown): boolean {
  const c = component as { text?: unknown; rebuild?: unknown };
  return typeof c?.text === "string" && typeof c?.rebuild === "function";
}

/** pi 的 SkillInvocationMessageComponent 形状：skillBlock + updateDisplay */
export function isSkillComponent(component: unknown): boolean {
  const c = component as { skillBlock?: unknown; updateDisplay?: unknown };
  return typeof c?.skillBlock === "object" && c.skillBlock !== null && typeof c?.updateDisplay === "function";
}

/** 组件渲染行数（0 行也算；渲染抛错返回 undefined） */
export function renderHeight(component: unknown, width: number): number | undefined {
  try {
    const lines = (component as ComponentLike)?.render?.(width);
    return Array.isArray(lines) ? lines.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一次组件遍历得到的提问首行行号（0-based 内容坐标）。
 * user/skill 两类分别按出现顺序，与 locateTarget 的两类序号一一对应。
 */
export interface PromptRows {
  user: number[];
  skill: number[];
}

/**
 * 遍历转录组件树，记录每个用户组件与 skill 组件的首行行号。
 * doc = documentContainer（header + loadedResources + chat 的顺序），行号 = 前面所有组件的渲染行数之和。
 * target 提供时命中目标即提前返回（与旧 locatePromptRow 语义一致：目标之后的组件不参与测高）；
 * 省略则全量遍历（自动定位用）。组件或宽度不可用/渲染失败时返回 undefined。
 */
export function collectPromptRows(
  doc: { children?: unknown[] } | undefined,
  chat: { children?: unknown[] } | undefined,
  width: number,
  target?: LocateTarget,
): PromptRows | undefined {
  if (!doc?.children || !chat?.children) return undefined;
  const docChildren = doc.children;
  // header + loadedResources + chat：chat 之前的所有兄弟高度都算入偏移
  let row = 0;
  const userRows: number[] = [];
  const skillRows: number[] = [];
  for (const child of docChildren) {
    if (child === chat) {
      for (const chatChild of chat.children) {
        if (isUserMessageComponent(chatChild)) userRows.push(row);
        else if (isSkillComponent(chatChild)) skillRows.push(row);
        if (target && (target.kind === "user" ? userRows.length > target.ordinal : skillRows.length > target.ordinal)) {
          return { user: userRows, skill: skillRows };
        }
        const height = renderHeight(chatChild, width);
        if (height === undefined) return undefined;
        row += height;
      }
      return { user: userRows, skill: skillRows };
    }
    const height = renderHeight(child, width);
    if (height === undefined) return undefined;
    row += height;
  }
  return undefined; // chat 不在 doc 的子节点里
}

/** 定位目标提问组件（用户组件或 skill 组件）的首行行号；不可定位/渲染失败时返回 undefined */
export function locatePromptRow(
  doc: { children?: unknown[] } | undefined,
  chat: { children?: unknown[] } | undefined,
  width: number,
  target: LocateTarget,
): number | undefined {
  const rows = collectPromptRows(doc, chat, width, target);
  if (!rows) return undefined;
  return target.kind === "user" ? rows.user[target.ordinal] : rows.skill[target.ordinal];
}

/**
 * 当前视口附近的提问：取「首行 ≤ scrollTop」的最近一条（即视口顶部之前的提问）。
 * 计数与 locateTarget 完全一致（skill+正文 同时消费 user/skill 两个序号）。
 * 视口还在摘要区等无匹配时返回 undefined。
 */
export function promptIdAtRow(entries: EntryLike[], rows: PromptRows, scrollTop: number): string | undefined {
  let user = 0;
  let skill = 0;
  let found: string | undefined;
  for (const e of entries) {
    if (!isUserMessage(e)) continue;
    const skillStart = startsWithSkillBlock(e);
    const locatable = userIsLocatable(e);
    const row = skillStart ? rows.skill[skill] : locatable ? rows.user[user] : undefined;
    if (row !== undefined && row <= scrollTop) found = e.id;
    if (skillStart) skill++;
    if (locatable) user++;
  }
  return found;
}

/** 在 tui.children 里找 documentContainer 与 chatContainer（结构：document 的最后一个容器 = chat） */
export function findTranscriptContainers(tui: TuiLike): { doc: { children?: unknown[] }; chat: { children?: unknown[] } } | undefined {
  const doc = tui?.children?.[0];
  const docChildren = doc?.children;
  if (!Array.isArray(docChildren) || docChildren.length < 2) return undefined;
  const chat = docChildren[docChildren.length - 1];
  if (!chat || !Array.isArray((chat as { children?: unknown[] }).children)) return undefined;
  return { doc: doc as { children?: unknown[] }, chat: chat as { children?: unknown[] } };
}

/** 取转录内容行与内容宽度（用于边界校验与测高宽度），并带回当前滚动位置（自动定位用） */
export function transcriptGeometry(tui: TuiLike): { lines?: string[]; contentWidth?: number; scrollTop?: number } {
  const layout = tui?.currentLayout;
  const scrollView = tui?.getPrimaryScrollView?.();
  if (!layout || !scrollView) return {};
  let lines: string[] | undefined;
  let rectWidth: number | undefined;
  const visit = (box: unknown): void => {
    const b = box as {
      scrollView?: unknown;
      children?: unknown[];
      scrollContentLines?: string[];
      rect?: { width?: number };
    };
    if (!b) return;
    if (b.scrollView === scrollView) {
      lines = b.scrollContentLines;
      rectWidth = b.rect?.width;
      return;
    }
    for (const child of b.children ?? []) visit(child);
  };
  visit((layout as { root?: unknown }).root ?? layout);
  const contentWidth =
    rectWidth === undefined ? undefined : typeof scrollView.getContentWidth === "function" ? scrollView.getContentWidth(rectWidth) : rectWidth;
  return { lines, contentWidth, scrollTop: typeof scrollView.scrollTop === "number" ? scrollView.scrollTop : undefined };
}

/** 滚动到指定行（内容坐标）；成功返回 true */
export function scrollToRow(tui: TuiLike, row: number): boolean {
  const scrollView = tui?.getPrimaryScrollView?.();
  if (!scrollView || typeof scrollView.scrollTo !== "function") return false;
  scrollView.scrollTo(row);
  tui.requestRender?.();
  return true;
}

/** 相对时间（与 /tree 同类展示风格） */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) return "";
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

// ── 压缩提问的只读查看器 ──────────────────────────────────────────

/** 查看器正文小节 */
export interface ViewerSection {
  kind: "prompt" | "assistant" | "tool";
  /** prompt 原文 */
  text?: string;
  /** assistant 原始消息（交给原生 AssistantMessageComponent 渲染，含 thinking 折叠） */
  message?: EntryLike["message"];
  /** 工具调用（交给原生 ToolExecutionComponent 渲染，含折叠） */
  tool?: {
    name: string;
    id: string;
    args: unknown;
    result?: { content: unknown[]; details?: unknown; isError: boolean };
  };
}

/**
 * 压缩提问的查看器内容：提问原文 + 随后（下一条用户消息之前）的助手消息与工具调用。
 * 助手消息整体交给 AssistantMessageComponent（text + thinking，跳过其它块类型），
 * 工具调用拆成独立 tool 小节（官方渲染路径：历史条目用 toolCall/tool_use 块单独建 ToolExecutionComponent）。
 * 找不到该提问时返回空数组。
 */
export function buildViewerSections(entries: EntryLike[], entryId: string): ViewerSection[] {
  const start = entries.findIndex((e) => e.id === entryId);
  if (start < 0) return [];
  const first = entries[start];
  if (!first) return [];
  const sections: ViewerSection[] = [];
  const toolByCallId = new Map<string, NonNullable<ViewerSection["tool"]>>();
  const promptText = entryText(first).trim();
  if (promptText) sections.push({ kind: "prompt", text: promptText });
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (isUserMessage(e)) break; // 下一条用户消息起属于下一轮
    if (e.type && e.type !== "message") continue;
    if (e.message?.role === "assistant") {
      sections.push({ kind: "assistant", message: e.message });
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      for (const b of blocks) {
        if (b?.type !== "toolCall" && b?.type !== "tool_use") continue;
        const tool = b as { name?: string; id?: string; arguments?: unknown; input?: unknown };
        const item = { name: tool.name ?? "tool", id: tool.id ?? "", args: tool.arguments ?? tool.input ?? {} };
        toolByCallId.set(item.id, item);
        sections.push({ kind: "tool", tool: item });
      }
      continue;
    }
    if (e.message?.role === "toolResult") {
      // 会话格式里工具结果是独立 message 条目（role: toolResult），回填到对应调用
      const msg = e.message as { toolCallId?: string; content?: unknown[]; details?: unknown; isError?: boolean };
      const item = typeof msg.toolCallId === "string" ? toolByCallId.get(msg.toolCallId) : undefined;
      if (item) {
        item.result = { content: msg.content ?? [], details: msg.details, isError: msg.isError === true };
      }
    }
  }
  return sections;
}

/**
 * 读取宿主 pi 的 TUI 折叠设置（查看器继承 pi 的默认展示态）；
 * 读不到（无 settings.json / 解析失败）时回退 pi 默认值。
 */
export function readPiTuiSettings(agentDir: string = getAgentDir()): { hideThinkingBlock: boolean; toolOutputExpanded: boolean } {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      hideThinkingBlock?: unknown;
      toolOutputExpanded?: unknown;
    };
    return {
      hideThinkingBlock: raw.hideThinkingBlock === true,
      toolOutputExpanded: raw.toolOutputExpanded === true,
    };
  } catch {
    return { hideThinkingBlock: false, toolOutputExpanded: false };
  }
}

/**
 * 内置工具渲染器的最小复刻：官方内置 renderer 未随包导出（exports 只开放 "."），
 * 这里仅用官方导出的 renderDiff 复刻 pi 自身的编辑类展示（edit/write 的 diff 预览），
 * 其余内置/自定义工具走 ToolExecutionComponent 通用兜底。
 */
function builtinLikeRenderers(mode: DiffViewMode): Record<string, ToolRenderers> {
  const editorLike = (label: string): ToolRenderers =>
    ({
      renderCall: (args: any, theme: any) => {
        const path = String(args?.file_path ?? args?.path ?? "");
        return new Text(`${theme.fg("toolTitle", theme.bold(label))} ${path}`, 0, 0);
      },
      renderResult: (result: any, _options: any, theme: any, _context: any) => {
        const diff = result?.details?.diff;
        if (typeof diff !== "string" || !diff) return new Container();
        return new DiffViewComponent(diff, mode, theme) as unknown as Component;
      },
    }) as ToolRenderers;
  return { edit: editorLike("edit"), write: editorLike("write") };
}

/** 查看器固定开销行数：顶边框 + 空行 + 标题 + 空行 + 提示行 + 空行 */
const VIEWER_FIXED_ROWS = 6;
/** 内容区最小行数 */
const VIEWER_MIN_CONTENT_ROWS = 5;

/** 查看器环境：tui 引用、cwd、宿主折叠设置（与 pi 转录默认态一致） */
export interface ViewerEnv {
  tui: { terminal?: { rows?: number }; requestRender?: () => void };
  cwd?: string;
  hideThinkingBlock?: boolean;
  toolOutputExpanded?: boolean;
  diffViewMode?: DiffViewMode;
}

/**
 * 压缩提问的只读查看器（overlay 卡片）。
 * overlay 的子组件不做布局测量（renderedOverlayLayouts 只记录边界，不处理 LAYOUT_NODE），
 * ScrollView 在里面永远测不到视口 → 改自绘窗口滚动：render 时按 offset 切片，
 * 滚轮由 handleMouse 消费、↑↓/翻页由 handleInput 处理。
 * 样式：customMessageBg 底色（pi 自定义消息框同款）+ 完整盒边框，与转录背景清晰区隔，避免视觉凌乱。
 * 内容渲染继承 pi 原生：用户/助手消息、thinking 折叠、工具调用折叠均为官方组件与宿主设置。
 */
export class HistoryViewer extends Container implements Focusable {
  private readonly title: string;
  private readonly hint = "↑↓ 滚动 · PageUp/PageDown 翻页 · Esc/Enter 返回列表";
  private readonly theme: ThemeLike;
  private readonly sections: ViewerSection[];
  private readonly env: ViewerEnv;
  private readonly termRows: number;
  private readonly requestRender: () => void;
  private readonly onClose: () => void;
  private offset = 0;
  private contentLines: string[] = [];
  private contentWidthCache = -1;
  private lastInnerWidth = 0;
  /** 各小节组件实例（跨渲染复用，保留折叠/展开状态）与行区间 */
  private sectionRows: Array<{ component: { render(w: number): string[]; handleMouse?(e: unknown): unknown }; start: number; end: number }> = [];
  private sectionComponents: Array<{ render(w: number): string[]; handleMouse?(e: unknown): unknown } | undefined> = [];
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(title: string, sections: ViewerSection[], theme: ThemeLike, env: ViewerEnv, onClose: () => void) {
    super();
    this.title = title;
    this.theme = theme;
    this.sections = sections;
    this.env = env;
    this.termRows = env.tui?.terminal?.rows ?? 24;
    this.requestRender = env.tui?.requestRender ?? (() => {});
    this.onClose = onClose;
  }

  private maxContentRows(): number {
    return Math.max(VIEWER_MIN_CONTENT_ROWS, Math.floor(this.termRows * 0.85) - VIEWER_FIXED_ROWS);
  }

  /** 渲染全部正文行（按内容宽度缓存）；正文继承 pi 原生组件：用户/助手消息、thinking、工具折叠 */
  private buildContentLines(innerWidth: number): string[] {
    if (this.contentWidthCache === innerWidth) return this.contentLines;
    this.contentWidthCache = innerWidth;
    this.lastInnerWidth = innerWidth;
    const lines: string[] = [];
    this.sectionRows = [];
    const builtins = builtinLikeRenderers(this.env.diffViewMode ?? "auto");
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      if (!s) continue;
      if (lines.length > 0) lines.push("");
      const lineStart = lines.length;
      let component: { render(w: number): string[]; handleMouse?(e: unknown): unknown } | undefined = this.sectionComponents[i];
      if (!component) {
        if (s.kind === "prompt") {
          component = new UserMessageComponent(s.text ?? "", getMarkdownTheme(), 1);
        } else if (s.kind === "assistant" && s.message) {
          component = new AssistantMessageComponent(
            s.message as ConstructorParameters<typeof AssistantMessageComponent>[0],
            this.env.hideThinkingBlock,
            getMarkdownTheme(),
            undefined,
            1,
          );
        } else if (s.kind === "tool" && s.tool) {
          const toolComponent = new ToolExecutionComponent(
            s.tool.name,
            s.tool.id,
            s.tool.args,
            { outputPad: 1 },
            builtins[s.tool.name],
            this.env.tui as never,
            this.env.cwd ?? "",
          );
          toolComponent.setExpanded(this.env.toolOutputExpanded ?? false);
          if (s.tool.result) {
            toolComponent.updateResult(
              { content: s.tool.result.content as never[], details: s.tool.result.details, isError: s.tool.result.isError },
              false,
            );
          }
          component = toolComponent;
        }
        this.sectionComponents[i] = component;
      }
      if (component) {
        const sectionLines = component.render(innerWidth);
        for (const line of sectionLines) {
          // 超长行按显示宽度换行（sliceByColumn ANSI 感知）；每段尾部追加样式安全复位，
          // 防止切点落在复位序列前导致反色/前景泄漏到行尾补齐空格（反色残留 = 黑底）
          let remaining = line;
          while (visibleWidth(remaining) > innerWidth) {
            lines.push(stripFullResets(sliceByColumn(remaining, 0, innerWidth)) + ANSI_SAFE_RESET);
            remaining = sliceByColumn(remaining, innerWidth, visibleWidth(remaining) - innerWidth);
          }
          lines.push(stripFullResets(remaining) + ANSI_SAFE_RESET);
        }
        this.sectionRows.push({ component, start: lineStart, end: lines.length });
      }
    }
    this.contentLines = lines;
    return lines;
  }

  private clampOffset(): void {
    const maxOffset = Math.max(0, this.contentLines.length - this.maxContentRows());
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
  }

  private scrollBy(delta: number): void {
    this.clampOffset();
    this.offset = Math.max(0, Math.min(Math.max(0, this.contentLines.length - this.maxContentRows()), this.offset + delta));
    this.requestRender();
  }

  render(width: number): string[] {
    const w = Math.max(8, width);
    const inner = w - 2;
    const rows = this.maxContentRows();
    const all = this.buildContentLines(inner);
    this.clampOffset();

    const border = (text: string): string => this.theme.fg("border", text);
    // 卡片底色用 pi 自定义消息框同款 token（customMessageBg）；第三方主题可能缺 token，
    // 统一 try/catch 降级为无样式（盒边框仍可区隔），避免因主题缺色导致 pi 崩溃
    const style = (fn: (text: string) => string, text: string): string => {
      try {
        return fn(text);
      } catch {
        return text;
      }
    };
    const bg = (text: string): string => style((t) => (this.theme.bg ? this.theme.bg("customMessageBg", t) : t), text);
    const pad = (line: string): string => {
      const vw = visibleWidth(line);
      // 内容行已在 buildContentLines 换行到 ≤ inner；此处仅兜底（异常行不中途截断，交给合成层裁剪）
      if (vw > inner) return stripFullResets(sliceByColumn(line, 0, inner)) + ANSI_SAFE_RESET;
      return line + " ".repeat(inner - vw);
    };

    const out: string[] = [];
    out.push(border(`┌${"─".repeat(inner)}┐`));
    out.push(border("│") + bg(pad(" " + style((_t) => this.theme.fg("customMessageLabel", this.theme.bold(this.title)), this.title))) + border("│"));
    out.push(border("│") + bg(pad("")) + border("│"));
    out.push(border("│") + bg(pad(" " + style((_t) => this.theme.fg("dim", this.hint), this.hint))) + border("│"));
    out.push(border("│") + bg(pad("")) + border("│"));
    const window = all.slice(this.offset, this.offset + rows);
    for (const line of window) out.push(border("│") + bg(pad(line)) + border("│"));
    while (out.length < rows + VIEWER_FIXED_ROWS - 1) out.push(border("│") + bg(pad("")) + border("│"));
    out.push(border(`└${"─".repeat(inner)}┘`));
    return out;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
      this.onClose();
      return;
    }
    const up = kb.matches(data, "tui.select.up") || kb.matches(data, "tui.editor.cursorUp");
    const down = kb.matches(data, "tui.select.down") || kb.matches(data, "tui.editor.cursorDown");
    const pageUp = kb.matches(data, "tui.altScreen.pageUp") || kb.matches(data, "tui.select.pageUp");
    const pageDown = kb.matches(data, "tui.altScreen.pageDown") || kb.matches(data, "tui.select.pageDown");
    const rows = this.maxContentRows();
    const delta = pageUp ? -(rows - 1) : pageDown ? rows - 1 : up ? -1 : down ? 1 : 0;
    if (delta !== 0) this.scrollBy(delta);
  }

  /** 滚轮/点击：overlay 命中后事件派发到这里。滚轮自行消费滚动；点击转发给对应小节组件（折叠/展开切换） */
  handleMouse(event: TuiMouseEvent):
    | { handled: true; target: { component: Component; originX: number; originY: number; width: number; height: number } }
    | undefined {
    const wheelDelta = (event as { wheelDelta?: number }).wheelDelta;
    if (event.type === "wheel" && typeof wheelDelta === "number" && wheelDelta !== 0) {
      this.scrollBy(wheelDelta);
      return {
        handled: true,
        target: { component: this, originX: event.x, originY: event.y, width: event.width, height: event.height },
      };
    }
    if (event.type === "click" && event.button === "left") {
      // 内容区起点：输出行 5（顶边框/标题/空/提示/空）；x 减 1 为左边框列
      const contentY = event.y - (VIEWER_FIXED_ROWS - 1);
      if (contentY >= 0) {
        const line = this.offset + contentY;
        const hit = this.sectionRows.find((r) => line >= r.start && line < r.end);
        if (hit?.component.handleMouse) {
          const result = hit.component.handleMouse({
            ...event,
            x: event.x - 1,
            y: line - hit.start,
            width: this.lastInnerWidth,
            height: hit.end - hit.start,
          });
          if (result) {
            this.contentWidthCache = -1; // 折叠态已变，重建行与偏移
            this.requestRender();
            return {
              handled: true,
              target: { component: this, originX: event.x, originY: event.y, width: event.width, height: event.height },
            };
          }
        }
      }
      return undefined;
    }
    return undefined;
  }
}

// ── 选择器组件 ─────────────────────────────────────────────────────

/** 提问跳转选择器：输入过滤 + ←/→ 翻页 + ↑/↓ 选择（与 pi 会话选择器同款交互） */
export class JumpDialog extends Container implements Focusable {
  private searchInput = new Input();
  private list: SelectList;
  private allItems: SelectItem[];
  private filteredItems: SelectItem[];
  private currentIndex = 0;
  private listSlot: number;
  private readonly pageSize: number;
  private readonly onPick: (item: SelectItem) => void;
  private readonly onClose: () => void;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value; // IME 光标定位需要把焦点传给内嵌输入框
  }

  constructor(
    title: string,
    items: SelectItem[],
    theme: ThemeLike,
    onPick: (item: SelectItem) => void,
    onClose: () => void,
  ) {
    super();
    this.allItems = items;
    this.filteredItems = items;
    this.pageSize = Math.min(12, Math.max(1, items.length));
    this.onPick = onPick;
    this.onClose = onClose;

    // 与 pi 原生 select（ExtensionSelectorComponent）同款外观：边框 + 粗体标题 + 底部按键提示
    this.addChild(new BorderLine((text) => theme.fg("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listSlot = this.children.length;
    this.list = this.buildList(this.filteredItems);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ 选择 · ←/→ 翻页 · Enter 跳转 · Esc 关闭 · 直接输入过滤"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new BorderLine((text) => theme.fg("border", text)));
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.pageSize, getSelectListTheme(), {
      minPrimaryColumnWidth: 10,
      maxPrimaryColumnWidth: 72,
      // 按显示宽度截断（含 CJK/emoji 宽度），超宽加省略号——不再固定字符数截断
      truncatePrimary: (ctx) => truncateToWidth(ctx.text, ctx.maxWidth, "…"),
    });
    list.onSelectionChange = (item) => {
      this.currentIndex = this.filteredItems.indexOf(item);
    };
    list.onSelect = (item) => this.onPick(item);
    list.onCancel = () => this.onClose();
    return list;
  }

  private applyFilter(query: string): void {
    const q = query.trim().toLowerCase();
    this.filteredItems = q
      ? this.allItems.filter((item) => fuzzyMatch(q, `${item.label} ${item.description ?? ""}`).matches)
      : this.allItems;
    this.currentIndex = 0;
    this.list = this.buildList(this.filteredItems);
    this.children[this.listSlot] = this.list;
  }

  /** 异步定位完成后预选列表项；用户已输入过滤或移动过选择时不覆盖（尊重其操作）。返回是否已应用（用于决定是否重绘） */
  setInitialIndex(index: number): boolean {
    if (index <= 0) return false; // 默认就是最新项
    if (this.searchInput.getValue().trim() !== "" || this.currentIndex !== 0) return false;
    this.list.setSelectedIndex(index);
    this.currentIndex = index;
    return true;
  }

  private page(delta: number): void {
    const max = Math.max(0, this.filteredItems.length - 1);
    const next = Math.min(max, Math.max(0, this.currentIndex + delta * this.pageSize));
    this.list.setSelectedIndex(next);
    this.currentIndex = next;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
      return;
    }
    if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.pageUp")) {
      this.page(-1);
      return;
    }
    if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.pageDown")) {
      this.page(1);
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}

// ── 工具定义 ───────────────────────────────────────────────────────

const tool: ToolDefinition<TranscriptJumpConfig> = {
  id: "transcript-jump",
  description: "打开提问列表并跳转到对应位置（仅全屏）：/candy-jump",
  defaultConfig: { debug: false, shortcut: "alt+j", autoLocate: true, diffViewMode: "auto" },
  register(pi: ExtensionAPI, config: TranscriptJumpConfig, log: Logger): void {
    const openPicker = async (ctx: PickerCtx): Promise<void> => {
      if (ctx.mode !== "tui") return;
      const sm = ctx.sessionManager;
      if (!sm) return;

      // 列表来源 = 当前分支（getBranch）：被 /tree 切走的旧分支不展示；
      // 其中不在渲染集合（buildContextEntries）里的才是真·被压缩的旧消息
      const entries = ((sm.getBranch?.() ?? sm.getEntries?.()) ?? []) as EntryLike[];
      const prompts = listPrompts(entries);
      if (prompts.length === 0) {
        ctx.ui.notify("会话里还没有提问", "info");
        return;
      }

      // 当前渲染集合（compaction 之后不含旧消息）→ 决定哪些提问真的可跳
      const rendered = (sm.buildContextEntries?.() ?? entries) as EntryLike[];
      const renderedIds = new Set(rendered.map((e) => e.id));

      const items: SelectItem[] = prompts.map((p) => ({
        value: p.entryId,
        label: `${String(p.index).padStart(3, " ")}. ${p.text}`,
        description: `${formatRelativeTime(p.timestamp)}${renderedIds.has(p.entryId) ? "" : " ｜已压缩 · 可查看"}`,
      }));

      // 异步计算「当前视口附近的提问」（autoLocate 开启时预选列表项；定位失败静默回退最新项）
      const locateInitialEntry = async (): Promise<string | undefined> => {
        try {
          if (!tuiRef) return undefined;
          const { contentWidth, scrollTop } = transcriptGeometry(tuiRef);
          if (contentWidth === undefined || scrollTop === undefined) return undefined;
          const containers = findTranscriptContainers(tuiRef);
          if (!containers) return undefined;
          const rows = collectPromptRows(containers.doc, containers.chat, contentWidth);
          return rows ? promptIdAtRow(rendered, rows, scrollTop) : undefined;
        } catch {
          return undefined; // 自动定位失败不影响选择器使用
        }
      };

      let tuiRef: TuiLike | undefined;
      // 查看器返回后重开选择器时保持位置（首次打开走 autoLocate）
      let initialSelectionIndex = -1;
      // 不用 overlay：与 pi 原生 select 一致，替换编辑器区域全宽渲染（非弹窗）
      while (true) {
        const selected = await ctx.ui.custom<SelectItem>(
          (tui, theme, _keybindings, done) => {
            tuiRef = tui as TuiLike;
            const dialog = new JumpDialog(`提问跳转（${items.length} 条）`, items, theme as ThemeLike, (item) => done(item), () => done(null));
            if (config.autoLocate && initialSelectionIndex < 0) {
              // setTimeout 把重遍历推迟到选择器首帧渲染之后：打开不被组件测高阻塞（SelectList.invalidate 为空操作，应用后需 requestRender）
              setTimeout(() => {
                void locateInitialEntry().then((entryId) => {
                  if (!entryId) return;
                  const index = prompts.findIndex((p) => p.entryId === entryId);
                  if (dialog.setInitialIndex(index)) {
                    tuiRef?.requestRender?.();
                    log("自动定位默认选中", index, entryId);
                  }
                });
              }, 0);
            } else if (initialSelectionIndex >= 0) {
              dialog.setInitialIndex(initialSelectionIndex);
            }
            return dialog;
          },
        );
        if (!selected || !tuiRef) return;

        const prompt = prompts.find((p) => p.entryId === selected.value);
        if (!prompt) return;

        if (tuiRef.mode !== "fullscreen") {
          ctx.ui.notify("跳转仅支持 fullscreen 模式（/settings 可切换 TUI 模式）", "warning");
          return;
        }

        // 已被压缩：打开只读查看器（原文 + 助手回复），不滚动、不切换会话点；关闭后返回选择器
        if (!renderedIds.has(prompt.entryId)) {
          const sections = buildViewerSections(entries, prompt.entryId);
          if (sections.length === 0) {
            ctx.ui.notify("该提问已被压缩，但未能读取原文", "info");
            log("压缩提问：读取原文失败，停在当前", prompt.entryId);
            return; // 停在当前，不做任何滚动
          }
          initialSelectionIndex = prompts.findIndex((p) => p.entryId === prompt.entryId);
          log("压缩提问：打开只读查看器", prompt.entryId);
          await ctx.ui.custom<unknown>(
            (tui, theme, _keybindings, done) => {
              tuiRef = tui as TuiLike;
              return new HistoryViewer(
                `历史提问 #${prompt.index}（已压缩 · 只读）`,
                sections,
                theme as ThemeLike,
                {
                  tui: tui as { terminal?: { rows?: number }; requestRender?: () => void },
                  cwd: ctx.cwd ?? "",
                  ...readPiTuiSettings(),
                  diffViewMode: config.diffViewMode,
                },
                () => done(undefined),
              );
            },
            // 居中 overlay：滚轮/焦点优先路由到查看器，不会带动转录；高度可控，提示行不被裁剪
            { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
          );
          continue; // 返回选择器（保持位置）
        }

        // 定位目标：skill 块开头 → skill 组件；否则 → 用户组件（两类序号各自与渲染组件一一对应）
        const target = locateTarget(rendered, prompt.entryId);
        if (!target) {
          ctx.ui.notify("无法定位该提问", "warning");
          return;
        }

        const { lines, contentWidth } = transcriptGeometry(tuiRef);
        if (contentWidth === undefined) {
          ctx.ui.notify("无法读取转录布局（仅 fullscreen 模式支持跳转）", "warning");
          return;
        }
        const containers = findTranscriptContainers(tuiRef);
        if (!containers) {
          ctx.ui.notify("当前 TUI 布局不支持定位", "warning");
          return;
        }

        const row = locatePromptRow(containers.doc, containers.chat, contentWidth, target);
        if (row === undefined) {
          ctx.ui.notify("无法定位该提问（组件渲染失败或布局异常）", "warning");
          return;
        }
        // 行号越界自检（与布局行数对不上说明宽度/结构漂移）
        if (lines && (row < 0 || row >= lines.length)) {
          ctx.ui.notify("定位结果越界，无法跳转（可能 pi 版本不兼容）", "warning");
          return;
        }
        if (!scrollToRow(tuiRef, row)) {
          ctx.ui.notify("滚动失败（当前 TUI 不支持）", "warning");
          return;
        }
        log("跳转", prompt.entryId, "row", row, "宽度", contentWidth);
        return;
      }
    };

    pi.registerCommand("candy-jump", {
      description: "打开提问列表并跳转到对应位置（仅 fullscreen）",
      handler: async (_args, ctx) => openPicker(ctx),
    });

    pi.registerShortcut(config.shortcut as KeyId, {
      description: "打开会话提问跳转列表（candy-toolbox）",
      handler: async (ctx) => openPicker(ctx),
    });
  },
};

export default tool;
