import assert from "node:assert/strict";
import { link, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createLogger } from "../src/log.ts";
import { computeStats, RestoreError, restoreSnapshot, type RestoreDeps } from "../src/restore.ts";
import { appendSnapshot, createEmptyState, StateStore } from "../src/state.ts";
import { buildStoragePaths, createBackup } from "../src/storage.ts";
import type { FileBackupRecord, Snapshot } from "../src/types.ts";
import { makeConfig, makeTempDir, removeTempDir, writeTextFile } from "./helpers.ts";

interface Harness {
  root: string;
  workspace: string;
  deps: RestoreDeps;
  store: StateStore;
}

async function makeHarness(): Promise<Harness> {
  const root = await makeTempDir();
  const workspace = path.join(root, "workspace");
  await writeTextFile(path.join(workspace, ".keep"), "");
  const config = makeConfig();
  const paths = buildStoragePaths(path.join(root, "storage"), "s1");
  const store = new StateStore({ stateFile: paths.stateFile, sessionId: "s1" });
  store.setState(createEmptyState("s1"));
  const deps: RestoreDeps = {
    cwd: workspace,
    config,
    store,
    paths,
    logger: createLogger({ logFile: paths.logFile, enabled: false }),
    sleep: async () => {},
  };
  return { root, workspace, deps, store };
}

/** 跟踪一个文件并返回其当前内容的备份记录。 */
async function backup(h: Harness, storedPath: string, version = 1): Promise<FileBackupRecord> {
  return await createBackup({
    backupsDir: h.deps.paths.backupsDir,
    absolutePath: path.join(h.workspace, storedPath),
    storedPath,
    version,
  });
}

function target(files: Record<string, FileBackupRecord>): Snapshot {
  return { id: "target", key: "target", kind: "operation", createdAt: "", files };
}

test("computeStats reports changed files with line counts", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "one\ntwo\n");
    const record = await backup(h, "a.txt");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = record;

    await writeFile(path.join(h.workspace, "a.txt"), "one\nthree\nfour\n", "utf8");
    // 从当前恢复到目标会新增 "two" 并删除 "three"/"four"（CC yk2 语义）。
    const stats = await computeStats(h.deps, target({ "a.txt": record }));
    assert.deepEqual(stats.filesChanged, ["a.txt"]);
    assert.equal(stats.insertions, 1);
    assert.equal(stats.deletions, 2);
  } finally {
    await removeTempDir(h.root);
  }
});

test("computeStats reports no changes for identical content", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "a.txt"), "same");
    const record = await backup(h, "a.txt");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = record;
    const stats = await computeStats(h.deps, target({ "a.txt": record }));
    assert.deepEqual(stats.filesChanged, []);
    assert.equal(stats.insertions, 0);
    assert.equal(stats.deletions, 0);
  } finally {
    await removeTempDir(h.root);
  }
});

test("computeStats counts deletions for files that must disappear", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, "new.txt"), "line1\nline2\n");
    h.store.state.trackedFiles.push("new.txt");
    h.store.state.originals["new.txt"] = { backupFileName: null, version: 1, backupTime: "" };
    const stats = await computeStats(h.deps, target({ "new.txt": { backupFileName: null, version: 1, backupTime: "" } }));
    assert.deepEqual(stats.filesChanged, ["new.txt"]);
    assert.equal(stats.deletions, 2);
  } finally {
    await removeTempDir(h.root);
  }
});

test("computeStats marks binary changes as one insertion and deletion", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "bin.dat");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const record = await backup(h, "bin.dat");
    h.store.state.trackedFiles.push("bin.dat");
    h.store.state.originals["bin.dat"] = record;
    await writeFile(file, Buffer.from([0, 9, 9, 9, 9]));
    const stats = await computeStats(h.deps, target({ "bin.dat": record }));
    assert.deepEqual(stats.filesChanged, ["bin.dat"]);
    assert.equal(stats.insertions, 1);
    assert.equal(stats.deletions, 1);
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot writes the backup content and is idempotent", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "original");
    const record = await backup(h, "a.txt");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = record;

    await writeFile(file, "changed", "utf8");
    const first = await restoreSnapshot(h.deps, target({ "a.txt": record }));
    assert.deepEqual(first.changed, ["a.txt"]);
    assert.equal(await readFile(file, "utf8"), "original");

    const second = await restoreSnapshot(h.deps, target({ "a.txt": record }));
    assert.deepEqual(second.changed, []);
    assert.equal(second.unchanged, 1);
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot deletes files that did not exist at the target time", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "new.txt");
    await writeTextFile(file, "created by agent");
    h.store.state.trackedFiles.push("new.txt");
    h.store.state.originals["new.txt"] = { backupFileName: null, version: 1, backupTime: "" };

    const result = await restoreSnapshot(h.deps, target({ "new.txt": { backupFileName: null, version: 1, backupTime: "" } }));
    assert.deepEqual(result.changed, ["new.txt"]);
    await assert.rejects(readFile(file));
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot falls back to the first-seen original", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "v0");
    const original = await backup(h, "a.txt");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = original;

    await writeFile(file, "v1", "utf8");
    const later = await createBackup({
      backupsDir: h.deps.paths.backupsDir,
      absolutePath: file,
      storedPath: "a.txt",
      version: 2,
    });
    appendSnapshot(h.store.state, target({ "a.txt": later }));

    // 恢复到更早的、没有 a.txt 记录的快照。
    const result = await restoreSnapshot(h.deps, target({}));
    assert.deepEqual(result.changed, ["a.txt"]);
    assert.equal(await readFile(file, "utf8"), "v0");
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot skips symlinks", async () => {
  const h = await makeHarness();
  try {
    const real = path.join(h.workspace, "real.txt");
    await writeTextFile(real, "original");
    const record = await backup(h, "real.txt");
    h.store.state.trackedFiles.push("link.txt");
    h.store.state.originals["link.txt"] = record;
    const linkPath = path.join(h.workspace, "link.txt");
    try {
      await symlink(real, linkPath);
    } catch {
      return; // symlinks unavailable (e.g. missing privileges)
    }
    await writeFile(real, "changed", "utf8");
    const result = await restoreSnapshot(h.deps, target({ "link.txt": record }));
    assert.deepEqual(result.skipped, ["link.txt"]);
    assert.deepEqual(result.changed, []);
    assert.equal(await readFile(real, "utf8"), "changed");
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot skips hard-linked files", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "original");
    const record = await backup(h, "a.txt");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = record;
    try {
      await link(file, path.join(h.workspace, "b.txt"));
    } catch {
      return; // hard links unavailable
    }
    await writeFile(file, "changed", "utf8");
    const result = await restoreSnapshot(h.deps, target({ "a.txt": record }));
    assert.deepEqual(result.skipped, ["a.txt"]);
    assert.equal(await readFile(file, "utf8"), "changed");
  } finally {
    await removeTempDir(h.root);
  }
});

test("restoreSnapshot reports missing backups as failures", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "current");
    h.store.state.trackedFiles.push("a.txt");
    h.store.state.originals["a.txt"] = { backupFileName: "missing@v1", version: 1, backupTime: "" };

    await assert.rejects(
      () => restoreSnapshot(h.deps, target({ "a.txt": { backupFileName: "missing@v1", version: 1, backupTime: "" } })),
      (error: unknown) => {
        assert.ok(error instanceof RestoreError);
        assert.equal(error.failures[0]?.path, "a.txt");
        return true;
      },
    );
  } finally {
    await removeTempDir(h.root);
  }
});
