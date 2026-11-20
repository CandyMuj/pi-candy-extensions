/**
 * editor-history — 会话重建后重建编辑器历史（↑↓ 切换）
 *
 * pi 的编辑器历史只随提交追加、不清空，且换自定义编辑器时不搬运：
 *   /reload、/resume、/fork、/new 后 ↑↓ 历史会丢失或错乱
 *   （官方 issue #7997/#8798 均 closed: not_planned，至今未修）。
 * 本工具在 session_start（reason ≠ startup）按当前会话的用户消息重建 history；
 * 并每秒检测编辑器实例变化（如 pi-open-tui 这类扩展在 session_start 之后才安装自定义编辑器，
 * 重建跑在旧实例上会白干），实例一变就再重建，保证 ↑↓ 始终可用。
 *
 * 实现依赖两个 pi 运行时机制（细节见 docs/editor-history.md）：
 *   1. ctx.ui.setWidget 工厂借用 tui 引用（widget 按 key 隔离，临时添加后立即移除）
 *   2. tui.children 定位编辑器实例（形状匹配 Editor）
 * 降级：编辑器形状不匹配时静默不工作，不影响任何既有功能。
 * 日志：写 <logDir>/editor-history.log（$toolbox.debug || 本工具 debug）。
 */
import type { ExtensionAPI, CustomEditor } from "@earendil-works/pi-coding-agent";
import { entryText, isUserMessage, type EntryLike } from "../core/entries.ts";
import type { ToolDefinition } from "../core/config.ts";
import type { Logger } from "../core/log.ts";

/**
 * 从 session 消息重建编辑器历史。
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
    if (!isUserMessage(e)) continue;
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
  const t = tui as { children?: Array<{ children?: unknown[] }> } | undefined;
  for (const c of t?.children ?? []) {
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
 * 编辑器实例变化检测 + 重建（轮询用，可同步测试）。
 * 编辑器被替换（如自定义编辑器安装）后新实例的历史是空的/旧会话残留——
 * 返回新实例并对它重建 history；实例未变则原样返回，不做任何事。
 */
export function refreshEditorAndRebuild(
  tui: unknown,
  prevEditor: unknown,
  sessionManager: { getEntries(): EntryLike[] } | undefined,
  log?: (...args: unknown[]) => void,
): unknown {
  const editor = findCurrentEditor(tui) as { history: string[] } | undefined;
  if (editor && editor !== prevEditor) {
    rebuildHistoryFromSession(sessionManager, editor);
    log?.("editor-changed：已从 session 重建编辑器历史");
    return editor;
  }
  return prevEditor;
}

const tool: ToolDefinition = {
  id: "editor-history",
  description: "会话重建后重建编辑器历史（↑↓ 切换）",
  defaultConfig: { debug: false },
  register(pi: ExtensionAPI, _config: { debug?: boolean }, log: Logger): void {
    let tuiRef: unknown = undefined;
    let editorRef: unknown = undefined;
    let sessionRef: { getEntries(): EntryLike[] } | undefined = undefined;
    let installed = false;
    let watchTimer: ReturnType<typeof setInterval> | undefined;

    const rebuild = (reason: string): void => {
      if (!sessionRef) return;
      rebuildHistoryFromSession(sessionRef, editorRef as { history: string[] } | undefined);
      log(`${reason}：已从 session 重建编辑器历史`);
    };

    pi.on("session_start", (event, ctx) => {
      // 仅在交互式 TUI 安装：headless（print/json/rpc）没有 TUI，widget 工厂不会执行
      if (ctx.mode !== "tui") return;
      sessionRef = ctx.sessionManager;
      if (!installed) {
        installed = true;
        // 借 widget 工厂拿 tui 引用：widget 按 key 隔离（只动自己的 key），
        // 临时添加空组件后立即移除，同一同步块内无渲染间隙。
        ctx.ui.setWidget(
          "editor-history-borrow",
          (tui) => {
            tuiRef = tui;
            return { render: () => [], invalidate: () => {} }; // 空组件（Component 最小接口）
          },
          { placement: "belowEditor" },
        );
        ctx.ui.setWidget("editor-history-borrow", undefined); // 移除自己的 widget
        editorRef = findCurrentEditor(tuiRef);
        log("已安装：tui 引用取自 widget 工厂（key 隔离），不触碰编辑器其他状态");
        // 轮询兜底：扩展安装顺序不保证（自定义编辑器可能在本次 session_start 之后才替换），
        // 编辑器实例一变就重建，覆盖 reload 后编辑器重建/替换的竞态
        if (!watchTimer) {
          watchTimer = setInterval(() => {
            editorRef = refreshEditorAndRebuild(tuiRef, editorRef, sessionRef, log);
          }, 1000);
        }
      }
      // 会话重建（reload / resume / fork / new）后编辑器历史会错乱：pi 的 populateHistory
      // 只是 addToHistory 追加不清空，且可能跑在编辑器实例重建之前——
      // 按当前会话的用户消息重建 history（幂等；startup 走 pi 自身流程，不干预）
      if (event.reason !== "startup") {
        rebuild(event.reason);
      }
    });

    pi.on("session_shutdown", () => {
      if (watchTimer) {
        clearInterval(watchTimer);
        watchTimer = undefined;
      }
      sessionRef = undefined;
      editorRef = undefined;
    });
  },
};

export default tool;
