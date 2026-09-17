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
 *   - /compact 后旧消息不再渲染：选择被压缩的提问时降级滚动到会话顶部（摘要处）
 *   - 依赖 tui.children 的结构与组件 render 测高（与 click-cursor 同级内部 API 依赖），无回归保证
 */
import { getSelectListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  type KeyId,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  fuzzyMatch,
  getKeybindings,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../core/config.ts";
import type { Logger } from "../core/log.ts";

export interface TranscriptJumpConfig {
  /** 调试日志开关：与插件级 $toolbox.debug 为「或」关系，任一为 true 即写 <logDir>/transcript-jump.log */
  debug: boolean;
  /** 打开提问列表的快捷键（KeyId 格式，见 pi keybindings 文档） */
  shortcut: string;
  /** 打开选择器时异步预选当前视口附近的提问（不阻塞打开）；关闭则始终默认选中最新，且不做任何组件遍历 */
  autoLocate: boolean;
}

/** 预览单行显示宽度上限（防超长消息占内存；正常提问远小于此，视觉截断交给 SelectList 按终端宽度做） */
const PREVIEW_MAX_WIDTH = 400;

// ── 局部最小类型（零额外依赖）──────────────────────────────────────
interface EntryLike {
  [key: string]: unknown;
  type?: string;
  id?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
  };
}

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

type ThemeLike = { fg: (name: string, text: string) => string; bold: (text: string) => string };

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

/** 提取消息纯文本（跳过 thinking/tool 等非文本块） */
export function entryText(e: EntryLike): string {
  if (e.type && e.type !== "message") return "";
  const m = e.message;
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function isUserMessage(e: EntryLike): boolean {
  if (e.type && e.type !== "message") return false;
  return e.message?.role === "user";
}

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

/** 归一化时间戳：ISO 字符串 → epoch ms */
function toTimestamp(value: string | number | undefined): number {
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
  defaultConfig: { debug: false, shortcut: "alt+j", autoLocate: true },
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
        description: `${formatRelativeTime(p.timestamp)}${renderedIds.has(p.entryId) ? "" : " ｜已压缩"}`,
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
      // 不用 overlay：与 pi 原生 select 一致，替换编辑器区域全宽渲染（非弹窗）
      const selected = await ctx.ui.custom<SelectItem>(
        (tui, theme, _keybindings, done) => {
          tuiRef = tui as TuiLike;
          const dialog = new JumpDialog(`提问跳转（${items.length} 条）`, items, theme as ThemeLike, (item) => done(item), () => done(null));
          if (config.autoLocate) {
            // setTimeout 把重遍历推迟到选择器首帧渲染之后：打开不被组件测高阻塞（SelectList.invalidate 为空操作，应用后需 requestRender）
            setTimeout(() => {
              void locateInitialEntry().then((entryId) => {
                if (!entryId) return;
                const index = prompts.findIndex((p) => p.entryId === entryId);
                if (dialog.setInitialIndex(index)) tuiRef?.requestRender?.();
              });
            }, 0);
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

      // 已被压缩：旧消息不渲染 → 降级到会话顶部（摘要处）
      if (!renderedIds.has(prompt.entryId)) {
        scrollToRow(tuiRef, 0);
        ctx.ui.notify("该提问已被压缩为摘要，已定位到会话顶部", "info");
        log("降级：提问已被压缩，滚到顶部", prompt.entryId);
        return;
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
