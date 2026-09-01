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
import type { ExtensionAPI, CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../core/config";

/** SGR 鼠标序列（与 pi 的 parseSgrMouseEvent 同款正则） */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

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
 * （editorContainer），再在布局树中匹配该容器的 rect（= 编辑器显示区域）。
 */
export function findEditorRect(tui: unknown, editor: unknown): Rect | undefined {
  const t = tui as {
    currentLayout?: { root?: unknown };
    children?: Array<{ children?: unknown[] }>;
  };
  const root = t?.currentLayout?.root;
  if (!root) return undefined;
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
  return visit(root);
}

/** 屏幕坐标 → 文本位置并移动光标 */
export function moveCursorToScreen(editor: CustomEditor, x: number, y: number, rect: Rect): void {
  const e = editor as unknown as {
    scrollOffset: number;
    lastWidth: number;
    paddingX: number;
    buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
    setCursorCol(col: number): void;
    state: { cursorLine: number };
    tui: { requestRender(): void };
  };
  const textTop = rect.y + 1; // 顶边框之下
  const textBottom = rect.y + rect.height - 1; // 底边框之上
  const visualRow = y - textTop + e.scrollOffset;
  if (y < textTop || y >= textBottom || visualRow < 0) return;
  const visualLines = e.buildVisualLineMap(e.lastWidth);
  const vl = visualLines[visualRow];
  if (!vl) return; // 越界（含 autocomplete 行，自动忽略）
  const colX = x - rect.x - e.paddingX;
  const col = Math.max(vl.startCol, Math.min(colX, vl.startCol + vl.length));
  e.state.cursorLine = vl.logicalLine;
  e.setCursorCol(col);
  e.tui.requestRender();
}

/** 鼠标数据处理：仅拦截编辑器区域内的左键按下 */
export function handleMouseData(data: string, editor: CustomEditor | undefined, tui: unknown, log?: (...args: unknown[]) => void): MouseResult {
  const m = SGR_MOUSE_RE.exec(data);
  if (!m) return undefined; // 非鼠标序列
  const button = Number(m[1]);
  const x = Number(m[2]) - 1; // 1-based → 0-based
  const y = Number(m[3]) - 1;
  const isPress = m[4] === "M";
  if (button !== 0 || !isPress) return undefined; // 仅左键按下（滚轮/右键/释放交给 viewport）
  if (!editor || !tui) return undefined;
  if ((tui as { mode?: string }).mode !== "fullscreen") return undefined; // 仅全屏模式
  log?.(`鼠标点击 button=${button} x=${x} y=${y}`);
  const rect = findEditorRect(tui, editor);
  if (!rect) {
    log?.("未找到编辑器 rect（currentLayout 不可用？）");
    return undefined;
  }
  if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) {
    log?.(`点击在编辑器外 rect=${JSON.stringify(rect)}`);
    return undefined; // 编辑器外：交给 viewport（选区/滚动/链接等）
  }
  moveCursorToScreen(editor, x, y, rect);
  log?.(`光标已移动 rect=${JSON.stringify(rect)}`);
  return { consume: true };
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

    const log = (...args: unknown[]): void => {
      if (config.debug) console.log("[candy-toolbox] click-cursor:", ...args);
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
