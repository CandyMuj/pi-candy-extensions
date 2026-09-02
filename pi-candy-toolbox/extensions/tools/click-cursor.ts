/**
 * click-cursor — 全屏模式点击定位光标
 *
 * 仅 fullscreen 模式：鼠标点击输入框（编辑器区域）内任意位置，光标移动到点击处。
 *
 * 实现依赖三个 pi 运行时机制（细节见 docs/click-cursor.md）：
 *   1. ctx.ui.setWidget 工厂借用 tui 引用（widget 按 key 隔离，临时添加后立即移除，
 *      不碰 footer/编辑器/其他扩展的 widget）
 *   2. ctx.ui.onTerminalInput 监听器前置到 viewport 之前（安装时立即 + 每秒轮询兜底）
 *   3. tui.children 定位编辑器实例 + tui.currentLayout 布局树读取屏幕矩形
 *
 * 无回归保证：仅对「落在编辑器矩形内的左键按下」返回 consume，其余事件
 * （滚轮、选区拖拽、链接、右键粘贴、编辑器外点击）原样交给 viewport。
 * 已知限制：编辑器区域内的拖拽选区不再工作（按下被拦截为光标定位）。
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../core/config";

/** SGR 鼠标序列（与 pi 的 parseSgrMouseEvent 同款正则） */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** debug 日志文件路径（终端日志会遮挡 UI） */
const LOG_PATH = join(getAgentDir(), "candy-toolbox-click-cursor.log");

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type MouseResult = { consume: true } | undefined;

/** 会话 entry 结构子集（真实结构为 { type: "message", message: { role, content } }） */
interface EntryLike {
  type?: string;
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
}

/** 提取消息纯文本（跳过 thinking/tool 等非文本块） */
function entryText(e: EntryLike): string {
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

/**
 * 惰性确保自己的监听器排在 inputListeners 最前（先于 viewport 收到鼠标事件）。
 * 每次输入事件检查一次，开销极小；inputListeners 是运行时公开字段，替换安全
 * （pi 的 add/removeInputListener 都实时读取实例字段）。
 */
export function ensureFirst(tui: unknown, handler: (d: string) => MouseResult): void {
  const t = tui as { inputListeners?: Set<(d: string) => MouseResult> };
  const set = t?.inputListeners;
  if (!set || typeof set.values !== "function") return;
  if (set.size === 0 || set.values().next().value === handler) return;
  t.inputListeners = new Set([handler, ...[...set].filter((l) => l !== handler)]);
}

/**
 * reload 后从 session 消息重建编辑器历史（↑↓ 切换）。
 * 与 pi 的 populateHistory 同语义：全部 user 消息、最新在前、相邻去重、限 100 条。
 * 仅替换 history 数组本身，不触碰编辑器其他状态；幂等。
 */
export function rebuildHistoryFromSession(
  sessionManager: { getEntries(): EntryLike[] } | undefined,
  editor: { history: string[] } | undefined,
): void {
  if (!sessionManager || !editor || !Array.isArray(editor.history)) return;
  const texts: string[] = [];
  for (const e of sessionManager.getEntries()) {
    if (e?.type && e.type !== "message") continue;
    const msg = e?.message;
    if (msg?.role !== "user") continue;
    const t = entryText(e);
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (texts[texts.length - 1] === trimmed) continue; // 相邻去重
    texts.push(trimmed);
  }
  editor.history = texts.reverse().slice(0, 100); // 最新在前
}

/**
 * 从 tui.children 定位当前编辑器实例（editorContainer 中形状匹配 Editor 的子组件）。
 * 不替换编辑器时（恢复默认后）用它动态获取默认编辑器实例。
 */
export function findCurrentEditor(tui: unknown): CustomEditor | undefined {
  const t = tui as { children?: Array<{ children?: unknown[] }> };
  for (const c of t.children ?? []) {
    const child = c.children?.[0];
    if (
      child &&
      typeof child === "object" &&
      "buildVisualLineMap" in child &&
      "setCursorCol" in child &&
      "state" in child
    ) {
      return child as unknown as CustomEditor;
    }
  }
  return undefined;
}

/**
 * 在布局树中查找编辑器的屏幕矩形。
 * 布局树只展开 layout node（Stack/ScrollView）的 children，普通 Container 是叶子——
 * 编辑器实例不会出现在布局树中。因此先从 tui.children 找到包含编辑器实例的容器
 * （editorContainer），再在布局树中匹配该容器的 rect。
 * 布局溢出时（总行数 > 终端高度）TuiAltScreen 截取底部显示，布局 y 需转为屏幕 y。
 */
export function findEditorRect(tui: unknown, editor: unknown): Rect | undefined {
  const t = tui as {
    currentLayout?: { root?: { rect?: Rect } & Record<string, unknown>; height?: number };
    children?: Array<{ children?: unknown[] }>;
  };
  const layout = t?.currentLayout;
  if (!layout?.root?.rect) return undefined;
  // 布局溢出偏移：root 总行数 - 终端高度（>0 时底部对齐截取）
  const rootHeight = layout.root.rect.height;
  const frameHeight = layout.height ?? rootHeight;
  const offsetY = rootHeight > frameHeight ? rootHeight - frameHeight : 0;
  // 定位 editorContainer：children 中包含编辑器实例的容器
  const container = (t.children ?? []).find((c) => Array.isArray(c.children) && c.children.includes(editor));
  const target = container ?? editor; // 兼容直接匹配编辑器实例的情形
  const visit = (box: unknown): Rect | undefined => {
    const b = box as { component?: unknown; rect?: Rect; children?: unknown[] };
    if (!b) return undefined;
    if (b.component === target && b.rect) return b.rect;
    for (const child of b.children ?? []) {
      const r = visit(child);
      if (r) return r;
    }
    return undefined;
  };
  const r = visit(layout.root);
  return r ? { ...r, y: r.y - offsetY } : undefined;
}

/**
 * 码点显示宽度（与 pi 的 get-east-asian-width 判定对齐：isWide || isFullWidth 为 2，
 * ambiguous 如中文引号/破折号按 1——与 pi 内部 wrap/选区逻辑一致）。
 * 范围为主干近似（覆盖 CJK/全角/emoji 大区，个别空隙码点有微小偏差）。
 */
function charWidthCp(cp: number): number {
  if (cp >= 0x1f000) return 2; // emoji 大区（pi 用 emoji-regex，此处近似）
  if (cp === 0x3000) return 2; // 全角空格（fullwidth）
  if ((cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return 2; // 全角形式
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/标点/假名/谚文/统一表意等主干
    (cp >= 0xa960 && cp <= 0xa97f) || // 谚文扩展
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6b) || // CJK 兼容形式
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

/** 屏幕坐标 → 文本位置并移动光标 */
export function moveCursorToScreen(
  editor: CustomEditor,
  x: number,
  y: number,
  rect: Rect,
  log?: (...args: unknown[]) => void,
): void {
  const e = editor as unknown as {
    scrollOffset: number;
    lastWidth: number;
    paddingX: number;
    buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
    setCursorCol(col: number): void;
    state: { cursorLine: number; lines?: string[] };
    tui: { requestRender(): void };
  };
  const textTop = rect.y + 1; // 顶边框之下
  const textBottom = rect.y + rect.height - 1; // 底边框之上
  const visualRow = y - textTop + e.scrollOffset;
  if (y < textTop || y >= textBottom || visualRow < 0) return;
  const visualLines = e.buildVisualLineMap(e.lastWidth);
  const vl = visualLines[visualRow];
  if (!vl) return; // 越界（含 autocomplete 行，自动忽略）

  // 段起点显示宽度（近似：wrap 段除末段外均整宽 layoutWidth）
  let segIndex = 0;
  for (let i = 0; i < visualLines.length && visualLines[i] !== vl; i++) {
    if (visualLines[i].logicalLine === vl.logicalLine) segIndex++;
  }
  // 内容起点偏移校正：编辑器渲染宽度（lastWidth 反推）可能小于容器宽度（布局分配
  // 差异），内容近似居中偏移。实测样本（"字符字符 123123"）吻合该校正；
  // 渲染宽度不小于容器时 offsetX 自动为 0（左对齐/全宽场景不受影响）。
  const contentWidth = e.lastWidth + (e.paddingX ? e.paddingX * 2 : 1);
  const offsetX = rect.width > contentWidth ? Math.floor((rect.width - contentWidth) / 2) : 0;
  const localX = Math.max(0, x - rect.x - e.paddingX - offsetX - segIndex * e.lastWidth);

  // 按显示宽度映射到码元列（与 pi 宽度判定对齐；surrogate pair 按码点推进）
  const lineText = e.state.lines?.[vl.logicalLine]?.slice(vl.startCol, vl.startCol + vl.length) ?? "";
  let i = 0;
  let w = 0;
  while (i < lineText.length) {
    const cp = lineText.codePointAt(i) ?? 0;
    const cw = charWidthCp(cp);
    if (w + cw > localX) break;
    w += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  const col = vl.startCol + i;

  log?.(
    `光标定位: x=${x} rect=${JSON.stringify(rect)} paddingX=${e.paddingX} lastWidth=${e.lastWidth} ` +
      `scrollOffset=${e.scrollOffset} visualRow=${visualRow} segIndex=${segIndex} offsetX=${offsetX} localX=${localX} ` +
      `line=${vl.logicalLine} col=${col} lineText=${JSON.stringify(lineText.slice(0, 40))}`,
  );

  e.state.cursorLine = vl.logicalLine;
  e.setCursorCol(col);
  e.tui.requestRender();
}

// ── 点击/拖拽判定状态 ────────────────────────────────────────────
/** 编辑器内左键按下待判定（未移动的释放 = 点击；移动 = 拖拽选择） */
let pendingPress: { x: number; y: number } | undefined;

/** 清除 viewport 的选区状态（点击定位后防止残留锚点/双击误判/剪贴板覆盖） */
function clearSelection(tui: unknown, log?: (...args: unknown[]) => void): void {
  const t = tui as Record<string, unknown> & { stopSelectionAutoScroll?: () => void; requestRender?: () => void };
  for (const key of [
    "selectionAnchor",
    "selectionFocus",
    "selectionPressActive",
    "selectionDragged",
    "pressedUrl",
    "selectionInitialRange",
    "selectionGranularity",
  ]) {
    if (key in t) t[key] = undefined;
  }
  try {
    t.stopSelectionAutoScroll?.();
    t.requestRender?.();
  } catch {
    // 清除失败不影响光标定位
  }
  log?.("已清除选区状态（点击定位）");
}

/**
 * 鼠标数据处理：点击定位与拖拽选择共存。
 * - 编辑器内左键按下：放行（viewport 建立选区锚点），记录待判定状态
 * - 左键移动（拖拽）：取消点击判定，全程放行 → 拖拽选择正常
 * - 未移动的释放：判定为点击 → 消费释放（viewport 不复制剪贴板/不残留状态），
 *   移动光标并清除选区状态
 * - 其余（右键/滚轮/编辑器外）一律放行
 */
export function handleMouseData(data: string, editor: CustomEditor | undefined, tui: unknown, log?: (...args: unknown[]) => void): MouseResult {
  const m = SGR_MOUSE_RE.exec(data);
  if (!m) return undefined; // 非鼠标序列
  const button = Number(m[1]);
  const x = Number(m[2]) - 1; // 1-based → 0-based
  const y = Number(m[3]) - 1;
  const isPress = m[4] === "M";
  const isRelease = m[4] === "m";
  const isLeftPress = button === 0 && isPress;
  const isLeftRelease = button === 0 && isRelease;
  const isLeftDrag = (button & 32) !== 0; // 左键按住移动
  if (!editor || !tui) return undefined;
  if ((tui as { mode?: string }).mode !== "fullscreen") return undefined; // 仅全屏模式

  const inRect = (r: { x: number; y: number; width: number; height: number }): boolean =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

  // 编辑器内左键按下：放行，记录待判定
  if (isLeftPress) {
    const rect = findEditorRect(tui, editor);
    if (rect && inRect(rect)) {
      pendingPress = { x, y };
      log?.(`按下（放行，待点击/拖拽判定）x=${x} y=${y}`);
    } else {
      pendingPress = undefined;
    }
    return undefined;
  }

  // 左键拖动：取消点击判定，拖拽选择交给 viewport
  if (isLeftDrag) {
    pendingPress = undefined;
    return undefined;
  }

  // 未移动的释放 = 点击：消费释放（viewport 不复制剪贴板），移动光标 + 清除选区
  if (isLeftRelease && pendingPress) {
    const pp = pendingPress;
    pendingPress = undefined;
    const moved = Math.abs(x - pp.x) > 1 || Math.abs(y - pp.y) > 1;
    if (!moved) {
      const rect = findEditorRect(tui, editor);
      if (!rect) {
        log?.("未找到编辑器 rect（currentLayout 不可用？）");
        return { consume: true };
      }
      // 非零宽选区 = 双击/三击选词产物（viewport 在 press 时已建立词/行选区）
      // → 不干预：保留选区高亮与自动复制，光标不移动
      const t = tui as {
        selectionAnchor?: { row?: number; col?: number };
        selectionFocus?: { row?: number; col?: number };
      };
      if (
        t.selectionAnchor &&
        t.selectionFocus &&
        (t.selectionAnchor.row !== t.selectionFocus.row || t.selectionAnchor.col !== t.selectionFocus.col)
      ) {
        log?.("双击/三击选词：不干预，放行");
        return undefined;
      }
      log?.(`点击判定 x=${x} y=${y}（未移动）`);
      moveCursorToScreen(editor, x, y, rect, log);
      clearSelection(tui, log);
      return { consume: true };
    }
    log?.(`释放已移动（拖拽结束，放行）`);
  }
  return undefined;
}

const tool: ToolDefinition = {
  id: "click-cursor",
  description: "全屏模式下点击输入框移动光标",
  defaultConfig: { debug: false },
  register(pi: ExtensionAPI, config: { debug?: boolean }): void {
    let tuiRef: unknown = undefined;
    let editorRef: CustomEditor | undefined = undefined;
    let installed = false;
    let ensureTimer: ReturnType<typeof setInterval> | undefined;

    // 调试日志写入文件（终端日志会遮挡 UI 且不便复制）
    const log = (...args: unknown[]): void => {
      if (!config.debug) return;
      try {
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.join(" ")}\n`, "utf-8");
      } catch {
        // 日志写入失败忽略
      }
    };

    const handler = (data: string): MouseResult => {
      ensureFirst(tuiRef, handler); // 惰性前置（模式切换 rebind 后自动兜住）
      return handleMouseData(data, editorRef, tuiRef, log);
    };

    pi.on("session_start", (event, ctx) => {
      if (!installed) {
        installed = true;
        // 借 widget 工厂拿 tui 引用：widget 按 key 隔离（只动自己的 key），
        // 临时添加空组件后立即移除，同一同步块内无渲染间隙。
        // 不碰 footer/编辑器/其他扩展的 widget——pi-open-tui 等扩展的样式不受影响。
        ctx.ui.setWidget(
          "click-cursor-borrow",
          (tui) => {
            tuiRef = tui;
            return { render: () => [], invalidate: () => {} }; // 空组件（Component 最小接口）
          },
          { placement: "belowEditor" },
        );
        ctx.ui.setWidget("click-cursor-borrow", undefined); // 移除自己的 widget
        ctx.ui.onTerminalInput(handler);
        // 编辑器实例：从 tui.children 动态定位 pi 默认编辑器（从未被触碰）
        editorRef = findCurrentEditor(tuiRef);
        log("已安装：tui 引用取自 widget 工厂（key 隔离），编辑器与其他扩展零影响");
      }
      // reload 后 pi 不会重新 populateHistory（内存历史可能丢失/错乱），
      // 从 session 消息重建编辑器历史，保证 ↑↓ 历史切换可用（幂等，其他 reason 不动）
      if (event.reason === "reload") {
        rebuildHistoryFromSession(ctx.sessionManager, findCurrentEditor(tuiRef) as { history: string[] } | undefined);
        log("reload：已从 session 重建编辑器历史");
      }
      // 立即前置 + 轮询兜底：鼠标事件会被 viewport 优先 consume，
      // 若等 handler 首次收到键盘才前置，用户 reload 后直接点击将永远无效
      ensureFirst(tuiRef, handler);
      if (!ensureTimer) {
        ensureTimer = setInterval(() => ensureFirst(tuiRef, handler), 1000);
      }
      log("已安装，监听器前置状态:", (tuiRef as { inputListeners?: Set<unknown> })?.inputListeners?.values().next().value === handler);
    });

    pi.on("session_shutdown", () => {
      if (ensureTimer) {
        clearInterval(ensureTimer);
        ensureTimer = undefined;
      }
    });
  },
};

export default tool;
