/**
 * 测试公共工具与 stub。
 *
 * 注意：`core/config.ts` 在模块加载时就用 `getAgentDir()` 算好 `CONFIG_PATH`，
 * 所以需要自定义 agent 目录的测试必须：
 *   1. 先调用 `useTempAgentDir()`（内部设置 PI_CODING_AGENT_DIR）
 *   2. 再动态 import 被测模块（见各 *.test.ts 顶部）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 指向一个全新的临时 agent 目录；必须在动态 import 被测模块之前调用 */
export function useTempAgentDir(prefix = "candy-toolbox-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

/** 假 Logger：记录每次调用的参数 */
export interface FakeLogger {
  log: (...args: unknown[]) => void;
  calls: unknown[][];
}

export function makeLogger(): FakeLogger {
  const calls: unknown[][] = [];
  return {
    calls,
    log: (...args: unknown[]) => {
      calls.push(args);
    },
  };
}

/** 注册的 command stub */
export interface CommandStub {
  description?: string;
  handler: (args: string, ctx: any) => any;
  getArgumentCompletions?: (prefix: string) => any;
}

/** pi API stub：记录注册的命令、快捷键与事件 handler */
export interface ShortcutStub {
  description?: string;
  handler: (ctx: any) => any;
}
export interface PiStub {
  pi: ExtensionAPI;
  commands: Map<string, CommandStub>;
  shortcuts: Map<string, ShortcutStub>;
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  setNames: string[];
}

export function makePiStub(sessionName?: string): PiStub {
  const commands = new Map<string, CommandStub>();
  const shortcuts = new Map<string, ShortcutStub>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const setNames: string[] = [];
  let name = sessionName;

  const pi = {
    registerCommand: (commandName: string, def: CommandStub) => {
      commands.set(commandName, def);
    },
    registerShortcut: (key: string, def: ShortcutStub) => {
      shortcuts.set(key, def);
    },
    registerTool: () => {},
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => name,
    setSessionName: (next: string) => {
      name = next;
      setNames.push(next);
    },
  };

  return { pi: pi as unknown as ExtensionAPI, commands, shortcuts, handlers, setNames };
}

/** 测试用 tui 引用（widget 工厂借用、onTerminalInput 落点） */
export interface TuiStub {
  children: unknown[];
  inputListeners: Set<(data: string) => unknown>;
  mode: string;
  requestRender: () => void;
}

/** ctx stub：记录 notify / setStatus / widget / 终端输入监听 */
export interface CtxStub {
  ctx: any;
  notices: Array<{ message: string; type: string }>;
  statuses: Map<string, string | undefined>;
  widgetKeys: string[];
  terminalHandlers: Array<(data: string) => unknown>;
  tui: TuiStub;
  custom: CustomStub;
  /** 完成 ui.custom 的选择（等价于调用工厂收到的 done） */
  resolveCustom: (value: any) => void;
}

/** ctx.ui.custom 的桩：记录工厂与选项 */
export interface CustomStub {
  factory?: (...args: any[]) => unknown;
  options?: unknown;
}

export interface CtxOptions {
  entries?: unknown[];
  /** buildContextEntries 的返回值（当前渲染集合）；缺省与 entries 相同 */
  contextEntries?: unknown[];
  /** getBranch 的返回值（当前分支）；缺省与 entries 相同 */
  branchEntries?: unknown[];
  mode?: string;
  modelRegistry?: any;
  model?: any;
  /** 放进 tui.children 的假编辑器（findCurrentEditor 的形状匹配目标） */
  editor?: unknown;
}

export function makeCtx(options: CtxOptions = {}): CtxStub {
  const notices: Array<{ message: string; type: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const widgetKeys: string[] = [];
  const terminalHandlers: Array<(data: string) => unknown> = [];
  const custom: CustomStub = {};
  let resolveCustom!: (value: any) => void;
  const customPromise = new Promise<any>((resolve) => {
    resolveCustom = resolve;
  });
  const tui: TuiStub = {
    children: options.editor === undefined ? [] : [{ children: [options.editor] }],
    inputListeners: new Set(),
    mode: "fullscreen",
    requestRender: () => {},
  };

  const ctx = {
    mode: options.mode ?? "tui",
    ui: {
      notify: (message: string, type = "info") => {
        notices.push({ message, type });
      },
      setStatus: (key: string, text?: string) => {
        statuses.set(key, text);
      },
      setWorkingIndicator: () => {},
      setWidget: (key: string, content: unknown) => {
        widgetKeys.push(key);
        if (typeof content === "function") {
          (content as (tui: unknown) => unknown)(tui);
        }
      },
      onTerminalInput: (handler: (data: string) => unknown) => {
        terminalHandlers.push(handler);
        return () => {};
      },
      custom: (factory: (...args: any[]) => unknown, customOptions?: unknown) => {
        custom.factory = factory;
        custom.options = customOptions;
        return customPromise;
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getBranch: () => options.branchEntries ?? options.entries ?? [],
      buildContextEntries: () => options.contextEntries ?? options.entries ?? [],
    },
    modelRegistry: options.modelRegistry,
    model: options.model,
  };

  return { ctx, notices, statuses, widgetKeys, terminalHandlers, tui, custom, resolveCustom };
}
