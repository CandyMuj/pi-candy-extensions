/**
 * Shared data types for pi-candy-undo.
 *
 * Storage model (see docs/design.md §3):
 * - A snapshot records the state of every tracked file at a point in time.
 * - Backups are immutable content copies; records only reference them.
 * - `originals` keeps the first-seen state of each file (CC v1 semantics).
 */

export type SnapshotKind = "baseline" | "operation" | "redo-point";

/** Reference to an immutable backup file (or "file did not exist"). */
export interface FileBackupRecord {
  /** Backup file name inside the session backup dir; null = file did not exist. */
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface Snapshot {
  /** Stable internal id (uuid); never changes. */
  id: string;
  /**
   * Binding target: the user message entry id this snapshot belongs to.
   * For the baseline snapshot it is a fixed sentinel; while an operation is
   * running it temporarily holds the operation id until binding happens.
   */
  key: string;
  files: Record<string, FileBackupRecord>;
  createdAt: string;
  kind: SnapshotKind;
}

export type RedoKind = "code" | "conversation" | "both";

export interface RedoItem {
  type: RedoKind;
  /** Snapshot key of the redo-point snapshot (code/both only). */
  restoreKey: string | null;
  /** Leaf id before the undo navigation (conversation/both only). */
  oldLeafId: string | null;
  createdAt: string;
}

export interface UndoState {
  version: 1;
  sessionId: string;
  snapshots: Snapshot[];
  originals: Record<string, FileBackupRecord>;
  trackedFiles: string[];
  redo: RedoItem[];
}

export type Language = "zh" | "en";

export interface UndoConfig {
  enabled: boolean;
  language: Language;
  storageDir: string;
  exclude: string[];
  excludeDefaults: boolean;
  trackedTools: string[];
  /** 0 = unlimited. */
  maxFileSizeMB: number;
  /** Minimum 1. */
  maxSnapshotsPerSession: number;
  /** 0 = redo disabled. */
  maxRedoStackSize: number;
  /** 0 = automatic cleanup disabled. */
  cleanupPeriodDays: number;
  /** Minimum 1. */
  pickerLimit: number;
  /** Reserved for v2 (tree integration); parsed but unused in v1. */
  treeRestore: "ask" | "off";
  log: boolean;
}

export interface RestoreStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
  /** Paths skipped because they are symlinks / hard links. */
  skipped: string[];
}

export interface RestoreFailure {
  path: string;
  error: string;
}

export interface RestoreResult {
  changed: string[];
  skipped: string[];
  /** Files compared and found already at target state (idempotent no-op). */
  unchanged: number;
}

/** Minimal shape of a session entry used by the plugin. */
export interface BranchEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export interface Logger {
  log(line: string): void;
}

export const BASELINE_SNAPSHOT_KEY = "baseline";
