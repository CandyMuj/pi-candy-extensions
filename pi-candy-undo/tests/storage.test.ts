import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  backupFileName,
  buildStoragePaths,
  cleanupExpiredSessions,
  createBackup,
  deleteUnreferencedBackups,
  listBackupFiles,
  migrateSessionData,
  readBackup,
  readSessionCwdFromFile,
  readSessionIdFromFile,
  readStateFile,
  writeStateFile,
} from "../src/storage.ts";
import { createEmptyState } from "../src/state.ts";
import { makeTempDir, removeTempDir, writeTextFile } from "./helpers.ts";

test("buildStoragePaths lays out state, backups and log", () => {
  const paths = buildStoragePaths("/root", "s1");
  assert.equal(paths.sessionDir, path.join("/root", "s1"));
  assert.equal(paths.stateFile, path.join("/root", "s1", "state.json"));
  assert.equal(paths.backupsDir, path.join("/root", "s1", "backups"));
  assert.equal(paths.logFile, path.join("/root", "undo.log"));
});

test("state file round trip is atomic and validated", async () => {
  const dir = await makeTempDir();
  try {
    const paths = buildStoragePaths(dir, "s1");
    const state = createEmptyState("s1");
    state.trackedFiles.push("a.txt");
    await writeStateFile(paths.stateFile, state);
    const loaded = await readStateFile(paths.stateFile);
    assert.deepEqual(loaded, state);

    await writeFile(paths.stateFile, "{broken", "utf8");
    assert.equal(await readStateFile(paths.stateFile), undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test("createBackup stores content and reports missing files", async () => {
  const dir = await makeTempDir();
  try {
    const paths = buildStoragePaths(dir, "s1");
    const file = path.join(dir, "a.txt");
    await writeTextFile(file, "hello");

    const first = await createBackup({
      backupsDir: paths.backupsDir,
      absolutePath: file,
      storedPath: "a.txt",
      version: 1,
    });
    assert.equal(first.version, 1);
    assert.equal(first.backupFileName, backupFileName("a.txt", 1));
    assert.equal((await readBackup(paths.backupsDir, first.backupFileName ?? ""))?.toString(), "hello");

    const missing = await createBackup({
      backupsDir: paths.backupsDir,
      absolutePath: path.join(dir, "nope.txt"),
      storedPath: "nope.txt",
      version: 1,
    });
    assert.equal(missing.backupFileName, null);
    assert.equal(missing.version, 1);
  } finally {
    await removeTempDir(dir);
  }
});

test("deleteUnreferencedBackups removes only unreferenced files", async () => {
  const dir = await makeTempDir();
  try {
    const paths = buildStoragePaths(dir, "s1");
    const file = path.join(dir, "a.txt");
    await writeTextFile(file, "one");
    const first = await createBackup({
      backupsDir: paths.backupsDir,
      absolutePath: file,
      storedPath: "a.txt",
      version: 1,
    });
    await writeTextFile(file, "two");
    const second = await createBackup({
      backupsDir: paths.backupsDir,
      absolutePath: file,
      storedPath: "a.txt",
      version: 2,
    });

    const removed = await deleteUnreferencedBackups(
      paths.backupsDir,
      new Set([second.backupFileName ?? ""]),
    );
    assert.equal(removed, 1);
    assert.deepEqual(await listBackupFiles(paths.backupsDir), [second.backupFileName]);
    assert.equal(first.backupFileName === second.backupFileName, false);
  } finally {
    await removeTempDir(dir);
  }
});

test("cleanupExpiredSessions removes old dirs but keeps the current one", async () => {
  const root = await makeTempDir();
  try {
    const oldDir = path.join(root, "old-session");
    const freshDir = path.join(root, "fresh-session");
    await writeStateFile(path.join(oldDir, "state.json"), createEmptyState("old-session"));
    await writeStateFile(path.join(freshDir, "state.json"), createEmptyState("fresh-session"));
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await (await import("node:fs/promises")).utimes(oldDir, old, old);

    const result = await cleanupExpiredSessions(root, 30 * 24 * 60 * 60 * 1000, "fresh-session");
    assert.deepEqual(result.removed, ["old-session"]);
    assert.deepEqual(result.errors, []);
    assert.equal(await readStateFile(path.join(freshDir, "state.json")) !== undefined, true);
  } finally {
    await removeTempDir(root);
  }
});

test("cleanupExpiredSessions with zero age does nothing", async () => {
  const root = await makeTempDir();
  try {
    await writeStateFile(path.join(root, "a", "state.json"), createEmptyState("a"));
    const result = await cleanupExpiredSessions(root, 0, "current");
    assert.deepEqual(result.removed, []);
  } finally {
    await removeTempDir(root);
  }
});

test("migrateSessionData copies state, clears redo and links backups", async () => {
  const root = await makeTempDir();
  try {
    const previous = buildStoragePaths(root, "prev");
    const next = buildStoragePaths(root, "next");
    const file = path.join(root, "a.txt");
    await writeTextFile(file, "content");
    const backup = await createBackup({
      backupsDir: previous.backupsDir,
      absolutePath: file,
      storedPath: "a.txt",
      version: 1,
    });
    const state = createEmptyState("prev");
    state.trackedFiles.push("a.txt");
    state.originals["a.txt"] = backup;
    state.redo.push({ type: "code", restoreKey: "x", oldLeafId: null, createdAt: "" });
    await writeStateFile(previous.stateFile, state);

    const result = await migrateSessionData(previous.sessionDir, next, "next");
    assert.equal(result.migrated, true);
    assert.equal(result.stateCopied, true);
    assert.equal(result.linked + result.copied, 1);

    const migrated = await readStateFile(next.stateFile);
    assert.equal(migrated?.sessionId, "next");
    assert.deepEqual(migrated?.redo, []);
    assert.equal(migrated?.originals["a.txt"]?.backupFileName, backup.backupFileName);
    assert.deepEqual(await listBackupFiles(next.backupsDir), [backup.backupFileName]);
  } finally {
    await removeTempDir(root);
  }
});

test("migrateSessionData ignores a missing previous session", async () => {
  const root = await makeTempDir();
  try {
    const next = buildStoragePaths(root, "next");
    const result = await migrateSessionData(path.join(root, "missing"), next, "next");
    assert.equal(result.migrated, false);
  } finally {
    await removeTempDir(root);
  }
});

test("session header readers extract id and cwd", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "s.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/work/proj" })}\n`,
      "utf8",
    );
    assert.equal(await readSessionIdFromFile(file), "abc");
    assert.equal(await readSessionCwdFromFile(file), "/work/proj");
    assert.equal(await readSessionIdFromFile(path.join(dir, "missing.jsonl")), undefined);
  } finally {
    await removeTempDir(dir);
  }
});

test("writeStateFile keeps a readable utf8 json payload", async () => {
  const dir = await makeTempDir();
  try {
    const paths = buildStoragePaths(dir, "s1");
    await writeStateFile(paths.stateFile, createEmptyState("s1"));
    const raw = await readFile(paths.stateFile, "utf8");
    assert.match(raw, /"sessionId": "s1"/);
    assert.equal(raw.endsWith("\n"), true);
  } finally {
    await removeTempDir(dir);
  }
});
