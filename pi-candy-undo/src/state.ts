/**
 * In-memory state operations and debounced persistence (docs/design.md §3, §4).
 */

import { randomUUID } from "node:crypto";
import type { FileBackupRecord, RedoItem, Snapshot, UndoState } from "./types.ts";
import { BASELINE_SNAPSHOT_KEY } from "./types.ts";
import { writeStateFile } from "./storage.ts";

export const DEFAULT_STATE_DEBOUNCE_MS = 500;

export function createEmptyState(sessionId: string): UndoState {
  return {
    version: 1,
    sessionId,
    snapshots: [],
    originals: {},
    trackedFiles: [],
    redo: [],
  };
}

export function createBaselineSnapshot(now: Date = new Date()): Snapshot {
  return {
    id: randomUUID(),
    key: BASELINE_SNAPSHOT_KEY,
    files: {},
    createdAt: now.toISOString(),
    kind: "baseline",
  };
}

/** Latest record seen for a file: newest snapshot containing it, else originals. */
export function latestRecordFor(state: UndoState, storedPath: string): FileBackupRecord | undefined {
  for (let index = state.snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = state.snapshots[index];
    const record = snapshot?.files[storedPath];
    if (record !== undefined) {
      return record;
    }
  }
  return state.originals[storedPath];
}

export function appendSnapshot(state: UndoState, snapshot: Snapshot): void {
  state.snapshots.push(snapshot);
}

/** Snapshot keys referenced by the redo stack; these must survive cap eviction. */
export function redoProtectedKeys(state: UndoState): Set<string> {
  const keys = new Set<string>();
  for (const item of state.redo) {
    if (item.restoreKey) {
      keys.add(item.restoreKey);
    }
  }
  return keys;
}

/**
 * Enforce `maxSnapshotsPerSession` by dropping the oldest snapshots.
 * The baseline is never evicted; snapshots referenced by the redo stack are
 * skipped (docs §6/§8). Returns the ids of removed snapshots.
 */
export function enforceSnapshotCap(state: UndoState, max: number, protectedKeys: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  if (max <= 0 || state.snapshots.length <= max) {
    return removed;
  }
  let excess = state.snapshots.length - max;
  const kept: Snapshot[] = [];
  for (const snapshot of state.snapshots) {
    if (excess > 0 && snapshot.kind !== "baseline" && !protectedKeys.has(snapshot.key)) {
      removed.push(snapshot.id);
      excess -= 1;
      continue;
    }
    kept.push(snapshot);
  }
  state.snapshots = kept;
  return removed;
}

export function clearRedo(state: UndoState): void {
  state.redo = [];
}

export function pushRedo(state: UndoState, item: RedoItem, max: number): void {
  if (max <= 0) {
    state.redo = [];
    return;
  }
  state.redo.push(item);
  if (state.redo.length > max) {
    state.redo = state.redo.slice(state.redo.length - max);
  }
}

export function peekRedo(state: UndoState): RedoItem | undefined {
  return state.redo[state.redo.length - 1];
}

export function popRedo(state: UndoState): RedoItem | undefined {
  return state.redo.pop();
}

/** All backup file names still referenced by snapshots or originals. */
export function collectReferencedBackups(state: UndoState): Set<string> {
  const referenced = new Set<string>();
  const add = (record: FileBackupRecord | undefined): void => {
    if (record?.backupFileName) {
      referenced.add(record.backupFileName);
    }
  };
  for (const snapshot of state.snapshots) {
    for (const record of Object.values(snapshot.files)) {
      add(record);
    }
  }
  for (const record of Object.values(state.originals)) {
    add(record);
  }
  return referenced;
}

export interface StateStoreOptions {
  stateFile: string;
  sessionId: string;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

/** Owns the session state and persists it with debouncing + atomic writes. */
export class StateStore {
  state: UndoState;

  private readonly options: StateStoreOptions;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private dirty = false;

  constructor(options: StateStoreOptions) {
    this.options = options;
    this.state = createEmptyState(options.sessionId);
  }

  setState(state: UndoState): void {
    this.state = state;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS);
    // Do not keep the process alive because of a pending flush.
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) {
        return;
      }
    }
    this.dirty = false;
    const snapshot = this.state;
    this.flushing = writeStateFile(this.options.stateFile, snapshot)
      .catch((error: unknown) => {
        this.dirty = true;
        this.options.onError?.(error);
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
  }

  async dispose(): Promise<void> {
    await this.flush();
  }
}
