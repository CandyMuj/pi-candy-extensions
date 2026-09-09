import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  expandHome,
  fromStoredPath,
  isSameOrInside,
  stripAtPrefix,
  toPosix,
  toStoredPath,
} from "../src/paths.ts";

const CWD = path.resolve("/work/proj");

test("toStoredPath keeps files inside cwd relative", () => {
  assert.equal(toStoredPath(CWD, path.join(CWD, "src", "index.ts")), "src/index.ts");
  assert.equal(toStoredPath(CWD, CWD), "");
});

test("toStoredPath keeps files outside cwd absolute", () => {
  const outside = path.resolve("/other/notes.txt");
  assert.equal(toStoredPath(CWD, outside), toPosix(outside));
});

test("fromStoredPath resolves relative and absolute stored paths", () => {
  assert.equal(fromStoredPath(CWD, "src/index.ts"), path.join(CWD, "src", "index.ts"));
  const absolute = path.resolve("/other/notes.txt");
  assert.equal(fromStoredPath(CWD, toPosix(absolute)), absolute);
});

test("round trip inside and outside cwd", () => {
  const inside = path.join(CWD, "a", "b.txt");
  const outside = path.resolve("/tmp/x.txt");
  assert.equal(fromStoredPath(CWD, toStoredPath(CWD, inside)), inside);
  assert.equal(fromStoredPath(CWD, toStoredPath(CWD, outside)), outside);
});

test("isSameOrInside compares case-insensitively on windows", () => {
  assert.equal(isSameOrInside("C:\\Work\\Proj", "c:\\work\\proj\\a.ts", "win32"), true);
  assert.equal(isSameOrInside("C:\\Work\\Proj", "c:\\work\\other\\a.ts", "win32"), false);
  assert.equal(isSameOrInside("/work/proj", "/work/proj/a.ts", "linux"), true);
  assert.equal(isSameOrInside("/work/proj", "/work/proj-other/a.ts", "linux"), false);
});

test("expandHome handles ~, ~/ and plain paths", () => {
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/x/y", "/home/u"), path.join("/home/u", "x", "y"));
  assert.equal(expandHome("~\\x", "C:\\Users\\u"), path.join("C:\\Users\\u", "x"));
  assert.equal(expandHome("/abs/path", "/home/u"), "/abs/path");
});

test("stripAtPrefix removes a single leading @", () => {
  assert.equal(stripAtPrefix("@src/index.ts"), "src/index.ts");
  assert.equal(stripAtPrefix("src/index.ts"), "src/index.ts");
  assert.equal(stripAtPrefix("@@x"), "@x");
});
