import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendSnapshot,
  clearRedo,
  collectReferencedBackups,
  createBaselineSnapshot,
  createEmptyState,
  enforceSnapshotCap,
  latestRecordFor,
  peekRedo,
  popRedo,
  pushRedo,
  redoProtectedKeys,
} from "../src/state.ts";
import type { FileBackupRecord, Snapshot } from "../src/types.ts";

function record(name: string | null, version: number): FileBackupRecord {
  return { backupFileName: name, version, backupTime: new Date(0).toISOString() };
}

function snapshot(key: string, kind: Snapshot["kind"], files: Record<string, FileBackupRecord>): Snapshot {
  return { id: `id-${key}`, key, kind, files, createdAt: new Date(0).toISOString() };
}

test("createEmptyState starts empty", () => {
  const state = createEmptyState("s1");
  assert.deepEqual(state, {
    version: 1,
    sessionId: "s1",
    snapshots: [],
    originals: {},
    trackedFiles: [],
    redo: [],
  });
});

test("createBaselineSnapshot uses the baseline sentinel", () => {
  const baseline = createBaselineSnapshot();
  assert.equal(baseline.kind, "baseline");
  assert.equal(baseline.key, "baseline");
  assert.deepEqual(baseline.files, {});
});

test("latestRecordFor prefers the newest snapshot then originals", () => {
  const state = createEmptyState("s");
  state.originals["a.txt"] = record("a@v1", 1);
  appendSnapshot(state, snapshot("k1", "operation", { "a.txt": record("a@v2", 2) }));
  appendSnapshot(state, snapshot("k2", "operation", {}));
  assert.equal(latestRecordFor(state, "a.txt")?.backupFileName, "a@v2");
  assert.equal(latestRecordFor(state, "missing.txt"), undefined);

  state.originals["b.txt"] = record(null, 1);
  assert.equal(latestRecordFor(state, "b.txt")?.backupFileName, null);
});

test("enforceSnapshotCap evicts oldest non-baseline snapshots", () => {
  const state = createEmptyState("s");
  const baseline = createBaselineSnapshot();
  appendSnapshot(state, baseline);
  appendSnapshot(state, snapshot("k1", "operation", {}));
  appendSnapshot(state, snapshot("k2", "operation", {}));
  appendSnapshot(state, snapshot("k3", "operation", {}));

  const removed = enforceSnapshotCap(state, 2, new Set());
  assert.deepEqual(removed, ["id-k1", "id-k2"]);
  assert.deepEqual(state.snapshots.map((s) => s.key), ["baseline", "k3"]);
});

test("enforceSnapshotCap keeps redo-protected and baseline snapshots", () => {
  const state = createEmptyState("s");
  appendSnapshot(state, createBaselineSnapshot());
  appendSnapshot(state, snapshot("k1", "operation", {}));
  appendSnapshot(state, snapshot("redo-1", "redo-point", {}));
  appendSnapshot(state, snapshot("k2", "operation", {}));

  const removed = enforceSnapshotCap(state, 2, new Set(["redo-1"]));
  assert.deepEqual(removed, ["id-k1", "id-k2"]);
  assert.deepEqual(state.snapshots.map((s) => s.key), ["baseline", "redo-1"]);
});

test("redo stack push/peek/pop/clear honours the cap", () => {
  const state = createEmptyState("s");
  pushRedo(state, { type: "code", restoreKey: "a", oldLeafId: null, createdAt: "" }, 2);
  pushRedo(state, { type: "code", restoreKey: "b", oldLeafId: null, createdAt: "" }, 2);
  pushRedo(state, { type: "code", restoreKey: "c", oldLeafId: null, createdAt: "" }, 2);
  assert.deepEqual(state.redo.map((item) => item.restoreKey), ["b", "c"]);
  assert.equal(peekRedo(state)?.restoreKey, "c");
  assert.equal(popRedo(state)?.restoreKey, "c");
  assert.equal(popRedo(state)?.restoreKey, "b");
  assert.equal(popRedo(state), undefined);

  pushRedo(state, { type: "code", restoreKey: "a", oldLeafId: null, createdAt: "" }, 0);
  assert.deepEqual(state.redo, []);
  clearRedo(state);
  assert.deepEqual(state.redo, []);
});

test("redoProtectedKeys and collectReferencedBackups", () => {
  const state = createEmptyState("s");
  state.originals["a.txt"] = record("a@v1", 1);
  appendSnapshot(state, snapshot("k1", "operation", { "a.txt": record("a@v2", 2) }));
  pushRedo(state, { type: "code", restoreKey: "k1", oldLeafId: null, createdAt: "" }, 10);

  assert.deepEqual([...redoProtectedKeys(state)], ["k1"]);
  assert.deepEqual([...collectReferencedBackups(state)].sort(), ["a@v1", "a@v2"]);
});
