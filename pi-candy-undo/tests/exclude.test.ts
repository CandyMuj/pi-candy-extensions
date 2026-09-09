import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_EXCLUDES } from "../src/config.ts";
import { createExcludeMatcher } from "../src/exclude.ts";

const CWD = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";

function matcher(patterns: string[], useDefaults = true) {
  return createExcludeMatcher({ cwd: CWD, patterns, useDefaults });
}

test("default excludes are applied", () => {
  const m = matcher([]);
  assert.equal(m.patterns.length, DEFAULT_EXCLUDES.length);
  assert.equal(m.isExcluded(path.join(CWD, ".git", "config")), true);
  assert.equal(m.isExcluded(path.join(CWD, "node_modules", "pkg", "index.js")), true);
  assert.equal(m.isExcluded(path.join(CWD, "dist", "app.js")), true);
  assert.equal(m.isExcluded(path.join(CWD, ".env")), true);
  assert.equal(m.isExcluded(path.join(CWD, "sub", ".env.local")), true);
  assert.equal(m.isExcluded(path.join(CWD, "pnpm-lock.yaml.lock")), true);
  assert.equal(m.isExcluded(path.join(CWD, "src", "index.ts")), false);
});

test("excludeDefaults false disables built-in defaults", () => {
  const m = matcher([], false);
  assert.equal(m.isExcluded(path.join(CWD, ".git", "config")), false);
  assert.equal(m.isExcluded(path.join(CWD, "node_modules", "pkg", "index.js")), false);
});

test("user patterns extend the defaults", () => {
  const m = matcher(["**/*.tmp", "secrets/**"]);
  assert.equal(m.isExcluded(path.join(CWD, "a", "b.tmp")), true);
  assert.equal(m.isExcluded(path.join(CWD, "secrets", "key.txt")), true);
  assert.equal(m.isExcluded(path.join(CWD, "src", "index.ts")), false);
});

test("negation re-includes a default exclusion", () => {
  const m = matcher(["!node_modules/keep/**"]);
  assert.equal(m.isExcluded(path.join(CWD, "node_modules", "pkg", "index.js")), true);
  assert.equal(m.isExcluded(path.join(CWD, "node_modules", "keep", "index.js")), false);
});

test("patterns without a slash match the basename at any depth", () => {
  const m = matcher(["*.snap"], false);
  assert.equal(m.isExcluded(path.join(CWD, "a", "b", "c.snap")), true);
  assert.equal(m.isExcluded(path.join(CWD, "c.snap")), true);
  assert.equal(m.isExcluded(path.join(CWD, "c.snap.txt")), false);
});

test("absolute patterns match files outside the workspace", () => {
  const outside = process.platform === "win32" ? "C:\\other\\notes.txt" : "/other/notes.txt";
  const m = matcher(["**/node_modules/**"], false);
  assert.equal(m.isExcluded(outside), false);
  const m2 = matcher(["**/other/**"], false);
  assert.equal(m2.isExcluded(outside), true);
});

test("windows matching is case-insensitive", { skip: process.platform !== "win32" }, () => {
  const m = matcher(["*.TMP"]);
  assert.equal(m.isExcluded(path.join(CWD, "a", "b.tmp")), true);
  assert.equal(m.isExcluded(path.join(CWD, ".GIT", "config")), true);
});

test("backslashes in user patterns are normalized", () => {
  const m = matcher(["secrets\\**"], false);
  assert.equal(m.isExcluded(path.join(CWD, "secrets", "key.txt")), true);
});

test("comments and empty patterns are ignored", () => {
  const m = matcher(["", "   ", "# comment"], false);
  assert.equal(m.patterns.length, 3);
  assert.equal(m.isExcluded(path.join(CWD, "src", "index.ts")), false);
});
