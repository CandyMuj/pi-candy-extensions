/**
 * candy-toolbox 统一日志
 *
 * 所有工具与插件自身的诊断信息都写文件，**绝不打印终端**：终端输出会污染
 * TUI（pi --help 的 stdout、非交互模式的 stderr、reload 时裸写屏幕），
 * 只有写文件才能在任何模式下都保持干净。
 *
 * 约定：
 *   - 目录：插件级配置 $toolbox.logDir（支持 ~ 展开，默认 ~/.pi/candy-toolbox-logs）
 *   - 文件名：<toolId>.log；插件自身传 TOOLBOX_KEY → $toolbox.log（与配置 key 同名，排序靠前，且不会与工具日志撞名）
 *   - 开关：由调用方算好（插件级 debug || 工具级 debug）；关闭时零副作用（不建目录、不开文件）
 *   - 目录惰性创建；写入失败一律静默——日志不允许影响 agent
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadRawConfig, resolveToolboxConfig } from "./config.ts";

/** 日志出口：当函数用即可，log("消息", 1, { a: 2 }) */
export type Logger = (...args: unknown[]) => void;

/** 开关关闭时的空实现（零副作用） */
const noop: Logger = () => {};

/** 参数序列化：Error 取堆栈，字符串原样，其余 JSON（无法序列化时退回 String） */
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack ?? arg.message;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * 创建某工具的日志出口。
 * @param toolId 文件名（<toolId>.log）；插件自身传 TOOLBOX_KEY（"$toolbox"）
 * @param enabled 是否写日志（已算好的最终开关）
 */
export function createLogger(toolId: string, enabled: boolean): Logger {
  if (!enabled) return noop;

  // 目录每次创建时读插件级配置：保证 /reload 后新配置立即生效（读取失败回退默认）
  const logDir = resolveToolboxConfig(loadRawConfig()).logDir;
  const file = join(logDir, `${toolId}.log`);
  let dirEnsured = false;

  return (...args: unknown[]): void => {
    try {
      if (!dirEnsured) {
        mkdirSync(logDir, { recursive: true });
        dirEnsured = true;
      }
      appendFileSync(file, `[${new Date().toISOString()}] [${toolId}] ${formatArgs(args)}\n`, "utf-8");
    } catch {
      // 日志写入失败静默：不抛错、不阻塞
    }
  };
}
