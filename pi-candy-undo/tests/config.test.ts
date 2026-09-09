import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDES,
  loadConfig,
  mergeSettingsDeep,
  parseUndoConfig,
} from "../src/config.ts";

test("defaults match the documented configuration", () => {
  assert.equal(DEFAULT_CONFIG.enabled, true);
  assert.equal(DEFAULT_CONFIG.language, "zh");
  assert.equal(DEFAULT_CONFIG.storageDir, "~/.pi/file-history");
  assert.equal(DEFAULT_CONFIG.excludeDefaults, true);
  assert.deepEqual(DEFAULT_CONFIG.trackedTools, ["write", "edit"]);
  assert.equal(DEFAULT_CONFIG.maxFileSizeMB, 100);
  assert.equal(DEFAULT_CONFIG.maxSnapshotsPerSession, 200);
  assert.equal(DEFAULT_CONFIG.maxRedoStackSize, 50);
  assert.equal(DEFAULT_CONFIG.cleanupPeriodDays, 30);
  assert.equal(DEFAULT_CONFIG.pickerLimit, 100);
  assert.equal(DEFAULT_CONFIG.log, false);
  assert.ok(DEFAULT_EXCLUDES.includes(".git/**"));
});

test("parseUndoConfig applies valid overrides", () => {
  const { config, warnings } = parseUndoConfig({
    enabled: false,
    language: "en",
    storageDir: "/tmp/history",
    exclude: ["*.tmp", "  "],
    excludeDefaults: false,
    trackedTools: ["write"],
    maxFileSizeMB: 0,
    maxSnapshotsPerSession: 5,
    maxRedoStackSize: 0,
    cleanupPeriodDays: 0,
    pickerLimit: 3,
    log: true,
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.enabled, false);
  assert.equal(config.language, "en");
  assert.equal(config.storageDir, "/tmp/history");
  assert.deepEqual(config.exclude, ["*.tmp"]);
  assert.equal(config.excludeDefaults, false);
  assert.deepEqual(config.trackedTools, ["write"]);
  assert.equal(config.maxFileSizeMB, 0);
  assert.equal(config.maxSnapshotsPerSession, 5);
  assert.equal(config.maxRedoStackSize, 0);
  assert.equal(config.cleanupPeriodDays, 0);
  assert.equal(config.pickerLimit, 3);
  assert.equal(config.log, true);
});

test("parseUndoConfig rejects invalid values and warns", () => {
  const { config, warnings } = parseUndoConfig({
    enabled: "yes",
    language: "fr",
    storageDir: "   ",
    exclude: "*.tmp",
    trackedTools: [],
    maxFileSizeMB: -1,
    maxSnapshotsPerSession: 0,
    maxRedoStackSize: -2,
    cleanupPeriodDays: -1,
    pickerLimit: 0,
    treeRestore: "always",
    log: 1,
  });
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(config.language, "zh");
  assert.equal(config.storageDir, DEFAULT_CONFIG.storageDir);
  assert.deepEqual(config.exclude, []);
  assert.deepEqual(config.trackedTools, DEFAULT_CONFIG.trackedTools);
  assert.equal(config.maxFileSizeMB, 100);
  assert.equal(config.maxSnapshotsPerSession, 200);
  assert.equal(config.maxRedoStackSize, 50);
  assert.equal(config.cleanupPeriodDays, 30);
  assert.equal(config.pickerLimit, 100);
  assert.equal(config.treeRestore, "off");
  assert.equal(config.log, false);
  assert.equal(warnings.length, 12);
});

test("mergeSettingsDeep merges objects and replaces arrays", () => {
  const merged = mergeSettingsDeep(
    { candyUndo: { language: "zh", exclude: ["a"], nested: { a: 1 } }, other: 1 },
    { candyUndo: { exclude: ["b"], nested: { b: 2 } } },
  );
  assert.deepEqual(merged, {
    other: 1,
    candyUndo: { language: "zh", exclude: ["b"], nested: { a: 1, b: 2 } },
  });
});

test("loadConfig merges global and project files and expands ~", () => {
  const files: Record<string, string> = {
    "global.json": JSON.stringify({ candyUndo: { language: "en", storageDir: "~/history", pickerLimit: 10 } }),
    "project.json": JSON.stringify({ candyUndo: { pickerLimit: 25 } }),
  };
  const { config, warnings } = loadConfig({
    globalSettingsFile: "global.json",
    projectSettingsFile: "project.json",
    readText: (file) => files[file],
    home: "/home/tester",
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.language, "en");
  assert.equal(config.storageDir, path.join("/home/tester", "history"));
  assert.equal(config.pickerLimit, 25);
});

test("loadConfig tolerates missing or corrupt settings files", () => {
  const { config, warnings } = loadConfig({
    globalSettingsFile: "missing.json",
    projectSettingsFile: "corrupt.json",
    readText: (file) => (file === "corrupt.json" ? "{not json" : undefined),
    home: "/home/tester",
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.storageDir, path.join("/home/tester", ".pi", "file-history"));
});
