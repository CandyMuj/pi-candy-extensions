/**
 * core/log.ts：统一文件日志（开关、命名、格式、目录来源）
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { useTempAgentDir } from "../helpers.ts";

const agentDir = useTempAgentDir();
const { CONFIG_PATH } = await import("../../extensions/core/config.ts");
const { createLogger } = await import("../../extensions/core/log.ts");

/** 每个用例用自己的日志目录，避免用例间互相看到对方写下的行 */
function dirFor(name: string): string {
  return join(agentDir, `${name}-logs`);
}

/** 写入 $toolbox 配置（logDir 来自插件级配置） */
function setLogDir(dir: string): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({ $toolbox: { logDir: dir } }), "utf8");
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8").trim().split("\n");
}

/** 去掉 "[时间] [tag] " 前缀，只留消息部分 */
function payload(line: string): string {
  return line.replace(/^\[[^\]]+\] \[[^\]]+\] /, "");
}

test("disabled logger has zero side effects", () => {
  const logsDir = dirFor("disabled");
  setLogDir(logsDir);
  createLogger("off-tool", false)("should be dropped", { any: 1 });
  assert.equal(existsSync(logsDir), false);
  assert.equal(existsSync(join(logsDir, "off-tool.log")), false);
});

test("enabled logger writes <logDir>/<toolId>.log with timestamp and tag", () => {
  const logsDir = dirFor("format");
  setLogDir(logsDir);
  createLogger("tool-a", true)("hello", 1, { a: 2 });

  const lines = readLines(join(logsDir, "tool-a.log"));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[tool-a\] /);
  assert.equal(payload(lines[0] ?? ""), 'hello 1 {"a":2}');
});

test("enabled logger appends and keeps per-tool files separate", () => {
  const logsDir = dirFor("append");
  setLogDir(logsDir);
  const a = createLogger("tool-a", true);
  const b = createLogger("tool-b", true);
  a("first");
  b("second");
  a("third");

  assert.deepEqual(readLines(join(logsDir, "tool-a.log")).map(payload), ["first", "third"]);
  assert.deepEqual(readLines(join(logsDir, "tool-b.log")).map(payload), ["second"]);
});

test("Error arguments are written as stacks", () => {
  const logsDir = dirFor("error");
  setLogDir(logsDir);
  createLogger("tool-err", true)(new Error("boom"));

  const text = readFileSync(join(logsDir, "tool-err.log"), "utf8");
  assert.match(text, /\[tool-err\] Error: boom/);
  assert.match(text, /at /);
});

test("logDir is read from $toolbox on every createLogger call", () => {
  const firstDir = dirFor("first");
  const secondDir = dirFor("second");
  setLogDir(secondDir);
  createLogger("tool-c", true)("to the second dir");

  assert.equal(existsSync(join(secondDir, "tool-c.log")), true);
  assert.equal(existsSync(join(firstDir, "tool-c.log")), false);
});
