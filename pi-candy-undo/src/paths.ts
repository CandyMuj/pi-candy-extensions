/**
 * 供 config / exclude / storage / tracker 共用的路径工具。
 *
 * 存储路径（state.json 的键）统一使用正斜杠：
 * - cwd 内文件 -> 相对 cwd 的路径（如 "src/index.ts"）
 * - cwd 外文件 -> 绝对路径（如 "C:/other/file.txt" 或 "/etc/hosts"）
 *
 * 正斜杠保证 Windows 上 minimatch 语义正确，并使状态文件跨平台可移植。
 */

import { homedir } from "node:os";
import path from "node:path";

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** 为 Windows 的大小写不敏感比较做归一化。 */
export function normalizeForCompare(input: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize(input);
  return isWindows(platform) ? normalized.toLowerCase() : normalized;
}

/** 当 `child` 等于 `parent` 或位于 `parent` 内时返回 true。 */
export function isSameOrInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rel = path.relative(normalizeForCompare(parent, platform), normalizeForCompare(child, platform));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 转换为正斜杠形式（用于存储路径与 glob 匹配）。 */
export function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

/** 绝对路径 -> 存储路径（cwd 内相对，cwd 外绝对）。 */
export function toStoredPath(
  cwd: string,
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isSameOrInside(cwd, absolutePath, platform)) {
    const rel = path.relative(cwd, absolutePath);
    return toPosix(rel);
  }
  return toPosix(path.resolve(absolutePath));
}

/** 存储路径 -> 绝对路径。 */
export function fromStoredPath(cwd: string, storedPath: string): string {
  if (path.isAbsolute(storedPath) || /^[A-Za-z]:[\\/]/.test(storedPath)) {
    return path.normalize(storedPath);
  }
  return path.resolve(cwd, storedPath);
}

/** 用给定主目录展开开头的 `~`（以及 `~/`、`~\`）。 */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** 去掉部分模型在路径参数前添加的 "@"。 */
export function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}
