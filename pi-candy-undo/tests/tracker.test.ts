import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createExcludeMatcher } from "../src/exclude.ts";
import { createLogger } from "../src/log.ts";
import { isSameOrInside } from "../src/paths.ts";
import { createEmptyState, StateStore } from "../src/state.ts";
import { buildStoragePaths } from "../src/storage.ts";
import { Tracker } from "../src/tracker.ts";
import { makeConfig, makeTempDir, removeTempDir, writeTextFile } from "./helpers.ts";

interface Harness {
  root: string;
  workspace: string;
  tracker: Tracker;
  store: StateStore;
  paths: ReturnType<typeof buildStoragePaths>;
  notices: Array<{ key: string; params?: Record<string, string | number> }>;
}

async function makeHarness(overrides: Parameters<typeof makeConfig>[0] = {}): Promise<Harness> {
  const root = await makeTempDir();
  const workspace = path.join(root, "workspace");
  await writeTextFile(path.join(workspace, ".keep"), "");
  const config = makeConfig(overrides);
  const paths = buildStoragePaths(path.join(root, "storage"), "s1");
  const store = new StateStore({ stateFile: paths.stateFile, sessionId: "s1" });
  store.setState(createEmptyState("s1"));
  const notices: Harness["notices"] = [];
  const tracker = new Tracker({
    cwd: workspace,
    config,
    matcher: createExcludeMatcher({
      cwd: workspace,
      patterns: config.exclude,
      useDefaults: config.excludeDefaults,
    }),
    store,
    paths,
    logger: createLogger({ logFile: paths.logFile, enabled: false }),
    isHardExcluded: (absolutePath) => isSameOrInside(paths.root, absolutePath),
    onNotice: (key, params) => notices.push({ key, params }),
  });
  return { root, workspace, tracker, store, paths, notices };
}

test("trackToolCall records the pre-edit content as version 1", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "original");
    await h.tracker.trackToolCall("write", { path: "a.txt", content: "new" });

    const record = h.store.state.originals["a.txt"];
    assert.equal(record?.version, 1);
    assert.deepEqual(h.store.state.trackedFiles, ["a.txt"]);
    assert.equal(
      (await readFile(path.join(h.paths.backupsDir, record?.backupFileName ?? ""), "utf8")),
      "original",
    );
  } finally {
    await removeTempDir(h.root);
  }
});

test("trackToolCall is idempotent and only tracks configured tools", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "original");
    await h.tracker.trackToolCall("write", { path: "a.txt" });
    await writeTextFile(file, "changed");
    await h.tracker.trackToolCall("write", { path: "a.txt" });
    assert.equal(h.store.state.originals["a.txt"]?.version, 1);

    await h.tracker.trackToolCall("bash", { path: "a.txt", command: "rm a.txt" });
    assert.deepEqual(h.store.state.trackedFiles, ["a.txt"]);

    await h.tracker.trackToolCall("write", { path: "b.txt" });
    assert.deepEqual(h.store.state.trackedFiles, ["a.txt", "b.txt"]);
  } finally {
    await removeTempDir(h.root);
  }
});

test("trackToolCall skips excluded, storage and symlinked paths", async () => {
  const h = await makeHarness();
  try {
    await writeTextFile(path.join(h.workspace, ".git", "config"), "[core]");
    await h.tracker.trackToolCall("write", { path: ".git/config" });
    await h.tracker.trackToolCall("write", { path: path.join(h.paths.root, "x.txt") });

    const target = path.join(h.workspace, "real.txt");
    await writeTextFile(target, "real");
    const link = path.join(h.workspace, "link.txt");
    await symlink(target, link);
    await h.tracker.trackToolCall("write", { path: "link.txt" });

    assert.deepEqual(h.store.state.trackedFiles, []);
  } finally {
    await removeTempDir(h.root);
  }
});

test("trackToolCall notifies once for oversize files", async () => {
  const h = await makeHarness({ maxFileSizeMB: 0.000001 });
  try {
    await writeTextFile(path.join(h.workspace, "big.txt"), "x".repeat(4096));
    await h.tracker.trackToolCall("write", { path: "big.txt" });
    await h.tracker.trackToolCall("write", { path: "big.txt" });
    assert.deepEqual(h.store.state.trackedFiles, []);
    assert.equal(h.notices.filter((notice) => notice.key === "notify.oversize").length, 1);
  } finally {
    await removeTempDir(h.root);
  }
});

test("trackToolCall strips a leading @ and resolves outside files", async () => {
  const h = await makeHarness();
  try {
    const outside = path.join(h.root, "outside.txt");
    await writeTextFile(outside, "outside");
    await h.tracker.trackToolCall("write", { path: `@${outside}` });
    assert.deepEqual(h.store.state.trackedFiles, [outside.replace(/\\/g, "/")]);
  } finally {
    await removeTempDir(h.root);
  }
});

test("beginOperation snapshots tracked files and reuses unchanged backups", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "v1");
    await h.tracker.trackToolCall("write", { path: "a.txt" });

    await h.tracker.beginOperation("leaf-1");
    const first = h.store.state.snapshots.at(-1);
    assert.equal(first?.kind, "operation");
    assert.equal(first?.files["a.txt"]?.backupFileName, h.store.state.originals["a.txt"]?.backupFileName);

    await h.tracker.beginOperation("leaf-1");
    assert.equal(h.store.state.snapshots.length, 1, "pending operation is not duplicated");

    h.tracker.finishOperation();
    await h.tracker.beginOperation("leaf-2");
    const second = h.store.state.snapshots.at(-1);
    assert.equal(second?.files["a.txt"]?.backupFileName, first?.files["a.txt"]?.backupFileName);

    await writeFile(file, "v2", "utf8");
    h.tracker.finishOperation();
    await h.tracker.beginOperation("leaf-3");
    const third = h.store.state.snapshots.at(-1);
    assert.equal(third?.files["a.txt"]?.version, 2);
    assert.notEqual(third?.files["a.txt"]?.backupFileName, first?.files["a.txt"]?.backupFileName);
  } finally {
    await removeTempDir(h.root);
  }
});

test("beginOperation records deletions and createRedoPoint captures current state", async () => {
  const h = await makeHarness();
  try {
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "v1");
    await h.tracker.trackToolCall("write", { path: "a.txt" });
    await h.tracker.beginOperation("leaf-1");
    h.tracker.finishOperation();

    await writeFile(file, "v2", "utf8");
    const redoPoint = await h.tracker.createRedoPoint();
    assert.equal(redoPoint.kind, "redo-point");
    assert.equal(redoPoint.files["a.txt"]?.version, 2);

    await (await import("node:fs/promises")).rm(file);
    h.tracker.finishOperation();
    await h.tracker.beginOperation("leaf-2");
    const snapshot = h.store.state.snapshots.at(-1);
    assert.equal(snapshot?.files["a.txt"]?.backupFileName, null);
  } finally {
    await removeTempDir(h.root);
  }
});

test("bindOperation attaches the snapshot to the first user message", async () => {
  const h = await makeHarness();
  try {
    await h.tracker.beginOperation("leaf-1");
    const branch = [
      { type: "message", id: "leaf-1", parentId: null, message: { role: "assistant", content: "hi" } },
      { type: "message", id: "u1", parentId: "leaf-1", message: { role: "user", content: "prompt" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "ok" } },
    ];
    assert.equal(h.tracker.bindOperation(branch), "u1");
    assert.equal(h.tracker.bindOperation(branch), "u1", "binding is idempotent");
    const snapshot = h.store.state.snapshots.at(-1);
    assert.equal(snapshot?.key, "u1");

    h.tracker.finishOperation();
    await h.tracker.beginOperation("a1");
    assert.equal(h.tracker.bindOperation(branch), undefined, "no user message after the leaf");
  } finally {
    await removeTempDir(h.root);
  }
});

test("ensureBaseline creates a single baseline snapshot", async () => {
  const h = await makeHarness();
  try {
    await h.tracker.ensureBaseline();
    await h.tracker.ensureBaseline();
    assert.equal(h.store.state.snapshots.filter((snapshot) => snapshot.kind === "baseline").length, 1);
  } finally {
    await removeTempDir(h.root);
  }
});

test("beginOperation detects same-size edits when mtimes collide", async () => {
  const h = await makeHarness();
  try {
    const { stat, utimes } = await import("node:fs/promises");
    const file = path.join(h.workspace, "a.txt");
    await writeTextFile(file, "v0");
    await h.tracker.trackToolCall("write", { path: "a.txt" });
    await h.tracker.beginOperation("leaf-1");
    h.tracker.finishOperation();

    // 大小相同（"v0" -> "v1"）且与备份的 mtime 相同：跟踪器
    // 仍必须继续做内容比较并创建新版本。
    await writeFile(file, "v1", "utf8");
    const original = h.store.state.originals["a.txt"];
    assert.ok(original?.backupFileName);
    const backupPath = path.join(h.paths.backupsDir, original.backupFileName);
    // 强制两个文件的时间戳完全相同，这样只有内容可能不同。
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    await utimes(file, stamp, stamp);
    await utimes(backupPath, stamp, stamp);
    assert.equal((await stat(file)).mtimeMs, (await stat(backupPath)).mtimeMs);

    await h.tracker.beginOperation("leaf-2");
    const snapshot = h.store.state.snapshots.at(-1);
    assert.equal(snapshot?.files["a.txt"]?.version, 2);
    assert.notEqual(snapshot?.files["a.txt"]?.backupFileName, original.backupFileName);
  } finally {
    await removeTempDir(h.root);
  }
});
