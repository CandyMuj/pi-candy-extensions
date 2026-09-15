/**
 * core/config.ts：$toolbox 插件级配置 + 工具开关归一化 + 配置写入
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "../../extensions/core/config.ts";
import { useTempAgentDir } from "../helpers.ts";

const agentDir = useTempAgentDir();
const {
  CONFIG_PATH,
  DEFAULT_TOOLBOX_CONFIG,
  TOOLBOX_KEY,
  loadRawConfig,
  resolveTool,
  resolveToolboxConfig,
  updateToolConfig,
} = await import("../../extensions/core/config.ts");

function writeConfig(value: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2), "utf8");
}

/** 归一化用的最小工具定义 */
function makeTool(overrides: Partial<ToolDefinition<{ option?: string }>> = {}): ToolDefinition<{ option?: string }> {
  return {
    id: "sample",
    description: "sample tool",
    defaultConfig: { option: "default" },
    register: () => {},
    ...overrides,
  };
}

test("$toolbox is the reserved plugin-level key", () => {
  assert.equal(TOOLBOX_KEY, "$toolbox");
});

test("defaults: debug off, logDir next to the agent dir", () => {
  assert.equal(DEFAULT_TOOLBOX_CONFIG.debug, false);
  assert.equal(DEFAULT_TOOLBOX_CONFIG.logDir, join(dirname(agentDir), "candy-toolbox-logs"));
  assert.deepEqual(resolveToolboxConfig({}), DEFAULT_TOOLBOX_CONFIG);
});

test("resolveToolboxConfig accepts valid fields", () => {
  const config = resolveToolboxConfig({ $toolbox: { debug: true, logDir: "~/candy-toolbox-test-logs" } });
  assert.equal(config.debug, true);
  assert.equal(config.logDir, join(homedir(), "candy-toolbox-test-logs"));
});

test("resolveToolboxConfig expands ~ and resolves relative paths", () => {
  assert.equal(resolveToolboxConfig({ $toolbox: { logDir: "~" } }).logDir, homedir());
  assert.equal(resolveToolboxConfig({ $toolbox: { logDir: "rel-logs" } }).logDir, resolve("rel-logs"));
});

test("resolveToolboxConfig falls back on invalid values", () => {
  assert.deepEqual(resolveToolboxConfig({ $toolbox: true }), DEFAULT_TOOLBOX_CONFIG);
  assert.deepEqual(resolveToolboxConfig({ $toolbox: { debug: "yes", logDir: 42 } }), DEFAULT_TOOLBOX_CONFIG);
  assert.deepEqual(resolveToolboxConfig({ $toolbox: { logDir: "   " } }), DEFAULT_TOOLBOX_CONFIG);
});

test("resolveToolboxConfig ignores tool keys", () => {
  const config = resolveToolboxConfig({ "session-title": { mode: "local" }, hello: false, $toolbox: { debug: true } });
  assert.equal(config.debug, true);
  assert.equal(config.logDir, DEFAULT_TOOLBOX_CONFIG.logDir);
});

test("resolveTool: three switch forms", () => {
  const tool = makeTool();
  assert.equal(resolveTool(tool, true).enabled, true);
  assert.equal(resolveTool(tool, false).enabled, false);
  const merged = resolveTool(tool, { option: "custom" });
  assert.equal(merged.enabled, true);
  assert.deepEqual(merged.config, { option: "custom" });
});

test("resolveTool: enabled:false inside the object disables the tool", () => {
  assert.equal(resolveTool(makeTool(), { enabled: false, option: "x" }).enabled, false);
});

test("resolveTool: missing or invalid config falls back to defaults", () => {
  const tool = makeTool({ defaultEnabled: false });
  assert.deepEqual(resolveTool(tool, undefined), { tool, enabled: false, config: { option: "default" } });
  assert.equal(resolveTool(makeTool(), 42).enabled, true);
  assert.equal(resolveTool(makeTool(), "nope").enabled, true);
});

test("loadRawConfig returns {} when the file is missing or broken", () => {
  rmSync(CONFIG_PATH, { force: true });
  assert.deepEqual(loadRawConfig(), {});

  writeFileSync(CONFIG_PATH, "{ not json", "utf8");
  assert.deepEqual(loadRawConfig(), {});
});

test("updateToolConfig writes the tool key and preserves other keys", () => {
  writeConfig({ $toolbox: { debug: true }, hello: false });
  assert.equal(updateToolConfig("session-title", { maxLength: 30 }), undefined);

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  assert.deepEqual(raw["$toolbox"], { debug: true });
  assert.equal(raw.hello, false);
  assert.deepEqual(raw["session-title"], { maxLength: 30 });
});

test("updateToolConfig merges into an existing tool object", () => {
  writeConfig({ "click-cursor": { debug: true, keep: 1 } });
  assert.equal(updateToolConfig("click-cursor", { debug: false }), undefined);

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  assert.deepEqual(raw["click-cursor"], { debug: false, keep: 1 });
});

test("updateToolConfig returns the error message instead of throwing", () => {
  // 把配置路径换成一个目录：读取回退 {}、写入必然失败 → 应返回字符串而不是抛错
  rmSync(CONFIG_PATH, { force: true });
  mkdirSync(CONFIG_PATH);
  const error = updateToolConfig("session-title", { maxLength: 15 });
  assert.ok(typeof error === "string" && error.length > 0);
});
