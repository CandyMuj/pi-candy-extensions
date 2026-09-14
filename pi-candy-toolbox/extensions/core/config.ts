/**
 * candy-toolbox 配置核心
 *
 * 配置文件位于 ~/.pi/agent/candy-toolbox.json（与 win-notify 同一约定）。
 * 每个工具在配置中拥有一个独立的顶层 key（即工具 id），key 下放该工具的
 * 具体配置。开关支持三种写法：
 *
 *   "tool-id": true        → 启用，使用默认配置
 *   "tool-id": false       → 禁用
 *   "tool-id": { ... }     → 启用，并浅合并覆盖默认配置
 *                            （也可写 { "enabled": false } 来禁用）
 *
 * 配置中未提到的工具按工具声明的 defaultEnabled 决定（默认启用）。
 *
 * 插件级配置放在保留 key "$toolbox" 下（不是工具 id；**工具 id 不得以 "$" 开头**）：
 *
 *   "$toolbox": { "debug": false, "logDir": "~/.pi/candy-toolbox-logs" }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Logger } from "./log";

/** 配置文件路径 */
export const CONFIG_PATH = join(getAgentDir(), "candy-toolbox.json");

/** 插件级配置的保留 key（不是工具 id） */
export const TOOLBOX_KEY = "$toolbox";

/** 插件级配置（$toolbox 下的字段） */
export interface ToolboxConfig {
  /** 总开关：true 时所有工具都写日志（工具级 debug 仍可单独开启某个工具） */
  debug: boolean;
  /** 日志目录（支持 ~ 展开；默认 ~/.pi/candy-toolbox-logs，即 agentDir 的同级目录） */
  logDir: string;
}

/** 插件级配置默认值（未配置或非法字段走这里；改默认值只需改这一处） */
export const DEFAULT_TOOLBOX_CONFIG: ToolboxConfig = {
  debug: false,
  logDir: join(dirname(getAgentDir()), "candy-toolbox-logs"),
};

/**
 * 一个工具的完整定义。每个工具文件默认导出一个 ToolDefinition，
 * 在 extensions/index.ts 的工具清单中登记。
 */
export interface ToolDefinition<TConfig extends object = Record<string, unknown>> {
  /** 工具 id：配置文件的顶层 key，全局唯一 */
  id: string;
  /** 一句话说明（README 工具清单展示用） */
  description: string;
  /** 默认配置，与用户配置浅合并 */
  defaultConfig: TConfig;
  /** 配置中未提到该工具时是否默认启用（默认 true） */
  defaultEnabled?: boolean;
  /** 注册逻辑，仅在工具启用时调用 */
  register(pi: ExtensionAPI, config: TConfig, log: Logger): void;
}

/** 归一化结果：开关状态 + 合并后的最终配置 */
export interface ResolvedTool<TConfig extends object = Record<string, unknown>> {
  tool: ToolDefinition<TConfig>;
  enabled: boolean;
  config: TConfig;
}

/** 读取原始配置；文件不存在或损坏时返回空对象（全部走默认） */
export function loadRawConfig(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
    }
  } catch {
    // 配置损坏：静默回退默认
  }
  return {};
}

/**
 * 展开开头的 `~` / `~/` / `~\` 为用户主目录（与 pi-candy-undo 同一约定）。
 */
function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

/** 归一化插件级配置（$toolbox）；未配置或非法值一律回退默认 */
export function resolveToolboxConfig(raw: Record<string, unknown>): ToolboxConfig {
  const value = raw[TOOLBOX_KEY];
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const dir = typeof obj.logDir === "string" ? obj.logDir.trim() : "";
  return {
    debug: typeof obj.debug === "boolean" ? obj.debug : DEFAULT_TOOLBOX_CONFIG.debug,
    // 相对路径按 cwd 解析；分隔符/盘符差异交给 path.resolve 处理
    logDir: dir ? resolve(expandHome(dir)) : DEFAULT_TOOLBOX_CONFIG.logDir,
  };
}

/**
 * 更新某工具在配置文件中的配置（保留其余字段与其他工具配置）。
 * 成功返回 undefined；失败返回异常信息字符串，由调用方负责提示。
 */
export function updateToolConfig(toolId: string, patch: Record<string, unknown>): string | undefined {
  try {
    const raw = loadRawConfig();
    const current =
      raw[toolId] && typeof raw[toolId] === "object" && !Array.isArray(raw[toolId])
        ? { ...(raw[toolId] as Record<string, unknown>) }
        : {};
    raw[toolId] = { ...current, ...patch };
    writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), "utf-8");
    return undefined;
  } catch (e) {
    // 本模块不接触 UI，也不打印终端：异常原因向上返回给调用方
    return (e as Error)?.message ?? String(e);
  }
}

/** 归一化单个工具的开关与配置，非法值一律回退默认 */
export function resolveTool<TConfig extends object>(
  tool: ToolDefinition<TConfig>,
  raw: unknown,
): ResolvedTool<TConfig> {
  const fallback: ResolvedTool<TConfig> = {
    tool,
    enabled: tool.defaultEnabled ?? true,
    config: { ...tool.defaultConfig },
  };
  if (raw === undefined || raw === null) return fallback;
  if (raw === true) return { tool, enabled: true, config: { ...tool.defaultConfig } };
  if (raw === false) return { tool, enabled: false, config: { ...tool.defaultConfig } };
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const { enabled, ...rest } = obj;
    const en = typeof enabled === "boolean" ? enabled : true;
    return { tool, enabled: en, config: { ...tool.defaultConfig, ...rest } };
  }
  return fallback;
}
