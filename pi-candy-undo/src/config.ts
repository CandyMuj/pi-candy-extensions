/**
 * 配置加载（docs/design.md §7）。
 *
 * 唯一来源：settings.json（全局 + 项目，项目覆盖全局）。不读取任何环境变量。
 */

import { readFileSync } from "node:fs";
import type { Language, UndoConfig } from "./types.ts";
import { expandHome } from "./paths.ts";

export const DEFAULT_EXCLUDES: readonly string[] = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "**/.env*",
  "*.lock",
  "coverage/**",
];

export const DEFAULT_TRACKED_TOOLS: readonly string[] = ["write", "edit"];

export const DEFAULT_CONFIG: UndoConfig = {
  enabled: true,
  language: "zh",
  storageDir: "~/.pi/file-history",
  exclude: [],
  excludeDefaults: true,
  trackedTools: [...DEFAULT_TRACKED_TOOLS],
  maxFileSizeMB: 100,
  maxSnapshotsPerSession: 200,
  maxRedoStackSize: 50,
  cleanupPeriodDays: 30,
  pickerLimit: 100,
  log: false,
};

export interface ParsedConfig {
  config: UndoConfig;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深合并：项目值覆盖基础值；数组整体替换。 */
export function mergeSettingsDeep(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) {
      continue;
    }
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = mergeSettingsDeep(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text || text.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseUndoConfig(raw: unknown, base: UndoConfig = DEFAULT_CONFIG): ParsedConfig {
  const warnings: string[] = [];
  const config: UndoConfig = { ...base, exclude: [...base.exclude], trackedTools: [...base.trackedTools] };

  if (raw === undefined) {
    return { config, warnings };
  }
  if (!isPlainObject(raw)) {
    warnings.push("candyUndo must be a JSON object; using defaults.");
    return { config, warnings };
  }

  const warn = (field: string, value: unknown, expected: string): void => {
    warnings.push(`candyUndo.${field} is invalid (${JSON.stringify(value)}); expected ${expected}. Using default.`);
  };

  const bool = (field: keyof UndoConfig): void => {
    const value = raw[field as string];
    if (value === undefined) return;
    if (typeof value === "boolean") {
      (config as unknown as Record<string, unknown>)[field as string] = value;
    } else {
      warn(field as string, value, "boolean");
    }
  };

  const number = (field: keyof UndoConfig, min: number, integer: boolean): void => {
    const value = raw[field as string];
    if (value === undefined) return;
    if (typeof value === "number" && Number.isFinite(value) && value >= min && (!integer || Number.isInteger(value))) {
      (config as unknown as Record<string, unknown>)[field as string] = value;
    } else {
      warn(field as string, value, `number >= ${min}${integer ? " (integer)" : ""}`);
    }
  };

  bool("enabled");
  bool("excludeDefaults");
  bool("log");
  number("maxFileSizeMB", 0, false);
  number("maxSnapshotsPerSession", 1, true);
  number("maxRedoStackSize", 0, true);
  number("cleanupPeriodDays", 0, true);
  number("pickerLimit", 1, true);

  const language = raw["language"];
  if (language !== undefined) {
    if (language === "zh" || language === "en") {
      config.language = language as Language;
    } else {
      warn("language", language, '"zh" or "en"');
    }
  }

  const storageDir = raw["storageDir"];
  if (storageDir !== undefined) {
    if (typeof storageDir === "string" && storageDir.trim() !== "") {
      config.storageDir = storageDir.trim();
    } else {
      warn("storageDir", storageDir, "non-empty string");
    }
  }

  const exclude = raw["exclude"];
  if (exclude !== undefined) {
    if (Array.isArray(exclude) && exclude.every((item) => typeof item === "string")) {
      config.exclude = exclude.map((item) => item.trim()).filter((item) => item !== "");
    } else {
      warn("exclude", exclude, "array of glob strings");
    }
  }

  const trackedTools = raw["trackedTools"];
  if (trackedTools !== undefined) {
    if (Array.isArray(trackedTools) && trackedTools.length > 0 && trackedTools.every((item) => typeof item === "string" && item.trim() !== "")) {
      config.trackedTools = trackedTools.map((item) => item.trim());
    } else {
      warn("trackedTools", trackedTools, "non-empty array of tool names");
    }
  }

  return { config, warnings };
}

export interface LoadConfigOptions {
  globalSettingsFile: string;
  projectSettingsFile: string;
  /** 可注入以便测试；默认使用 fs.readFileSync。 */
  readText?: (file: string) => string | undefined;
  home?: string;
}

/** 加载并合并全局 + 项目设置，然后校验 candyUndo 配置块。 */
export function loadConfig(options: LoadConfigOptions): ParsedConfig {
  const readText = options.readText ?? ((file: string): string | undefined => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  });

  const merged = mergeSettingsDeep(
    readJsonObject(readText(options.globalSettingsFile)),
    readJsonObject(readText(options.projectSettingsFile)),
  );

  const parsed = parseUndoConfig(merged["candyUndo"]);
  parsed.config.storageDir = expandHome(parsed.config.storageDir, options.home);
  return parsed;
}
