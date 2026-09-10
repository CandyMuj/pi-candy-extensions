/**
 * 排除匹配器（docs/design.md §7 “排除匹配语义”）。
 *
 * - 模式为 gitignore 风格 glob，由 minimatch 求值。
 * - `excludeDefaults` 为 true 时前置内置默认值，其后跟随用户模式。
 * - 后写的模式优先，因此 `!pattern` 可重新包含先前命中的路径。
 * - 不含 "/" 的模式按文件名匹配任意层级（minimatch matchBase）。
 * - 相对模式匹配 cwd 相对路径；对于 cwd 外文件同时匹配绝对路径；
 *   绝对模式仅匹配绝对路径。
 */

import { minimatch } from "minimatch";
import path from "node:path";
import { DEFAULT_EXCLUDES } from "./config.ts";
import { isSameOrInside, isWindows, toPosix } from "./paths.ts";

export interface ExcludeMatcher {
  /** 绝对路径是否必须排除在跟踪/备份/恢复之外。 */
  isExcluded(absolutePath: string): boolean;
  /** 生效的模式列表（默认值 + 用户模式），用于日志。 */
  patterns: readonly string[];
}

interface CompiledPattern {
  negated: boolean;
  absolute: boolean;
  body: string;
  matchBase: boolean;
}

const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

function compilePattern(raw: string): CompiledPattern | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }
  const negated = trimmed.startsWith("!");
  const body = (negated ? trimmed.slice(1) : trimmed).replace(/\\/g, "/");
  if (body === "") {
    return undefined;
  }
  const absolute = body.startsWith("/") || DRIVE_PREFIX.test(body);
  return { negated, absolute, body, matchBase: !body.includes("/") };
}

export interface CreateExcludeMatcherOptions {
  cwd: string;
  patterns: readonly string[];
  useDefaults: boolean;
  platform?: NodeJS.Platform;
}

export function createExcludeMatcher(options: CreateExcludeMatcherOptions): ExcludeMatcher {
  const platform = options.platform ?? process.platform;
  const nocase = isWindows(platform);
  const rawPatterns = [...(options.useDefaults ? DEFAULT_EXCLUDES : []), ...options.patterns];
  const compiled = rawPatterns
    .map(compilePattern)
    .filter((pattern): pattern is CompiledPattern => pattern !== undefined);

  const isExcluded = (absolutePath: string): boolean => {
    const absPosix = toPosix(path.resolve(absolutePath));
    const insideCwd = isSameOrInside(options.cwd, absolutePath, platform);
    const relPosix = insideCwd ? toPosix(path.relative(options.cwd, path.resolve(absolutePath))) : undefined;

    let excluded = false;
    for (const pattern of compiled) {
      const targets = pattern.absolute
        ? [absPosix]
        : relPosix !== undefined
          ? [relPosix, absPosix]
          : [absPosix];
      const hit = targets.some((target) =>
        minimatch(target, pattern.body, {
          dot: true,
          nocase,
          matchBase: pattern.matchBase,
        }),
      );
      if (hit) {
        excluded = !pattern.negated;
      }
    }
    return excluded;
  };

  return {
    isExcluded,
    patterns: rawPatterns,
  };
}
