/**
 * Exclude matcher (docs/design.md §7 "排除匹配语义").
 *
 * - Patterns are gitignore-flavoured globs evaluated with minimatch.
 * - Defaults are prepended when `excludeDefaults` is true; user patterns follow.
 * - Later patterns win, so `!pattern` re-includes earlier matches.
 * - Patterns without "/" match the basename at any depth (minimatch matchBase).
 * - Relative patterns are tested against the cwd-relative path and, for files
 *   outside cwd, against the absolute path; absolute patterns only against the
 *   absolute path.
 */

import { minimatch } from "minimatch";
import path from "node:path";
import { DEFAULT_EXCLUDES } from "./config.ts";
import { isSameOrInside, isWindows, toPosix } from "./paths.ts";

export interface ExcludeMatcher {
  /** True when the absolute path must not be tracked/backed up/restored. */
  isExcluded(absolutePath: string): boolean;
  /** Effective pattern list (defaults + user), for logging. */
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
