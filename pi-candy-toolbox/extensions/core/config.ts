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
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 配置文件路径 */
export const CONFIG_PATH = join(getAgentDir(), "candy-toolbox.json");

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
  register(pi: ExtensionAPI, config: TConfig): void;
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
