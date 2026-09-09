/**
 * Tracking layer (docs/design.md §5).
 *
 * - `trackToolCall` runs before a tracked tool writes: the first time a file is
 *   seen its pre-edit content is stored in `originals` (CC v1 semantics).
 * - `beginOperation` runs before an agent operation starts and records the
 *   current content of every tracked file as an operation snapshot.
 * - `bindOperation` attaches that snapshot to the user message entry that
 *   started the operation.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExcludeMatcher } from "./exclude.ts";
import type { MessageKey } from "./i18n.ts";
import { fromStoredPath, stripAtPrefix, toStoredPath } from "./paths.ts";
import type { StateStore } from "./state.ts";
import {
  appendSnapshot,
  collectReferencedBackups,
  createBaselineSnapshot,
  enforceSnapshotCap,
  latestRecordFor,
  redoProtectedKeys,
} from "./state.ts";
import { createBackup, deleteUnreferencedBackups, lstatOrNull, readBackup, type StoragePaths } from "./storage.ts";
import type { BranchEntry, FileBackupRecord, Logger, Snapshot, UndoConfig } from "./types.ts";

export interface TrackerOptions {
  cwd: string;
  config: UndoConfig;
  matcher: ExcludeMatcher;
  store: StateStore;
  paths: StoragePaths;
  logger: Logger;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Hard exclusion (storage dir and anything inside it). */
  isHardExcluded?: (absolutePath: string) => boolean;
  /** Notify the user (oversize files, backup failures). */
  onNotice?: (key: MessageKey, params?: Record<string, string | number>) => void;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
  return path.resolve(cwd, stripAtPrefix(rawPath));
}

function extractToolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)["path"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isUserMessageEntry(entry: BranchEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

export class Tracker {
  private readonly options: TrackerOptions;
  private pendingOperation: { snapshotId: string; operationKey: string; startLeafId: string | null } | undefined;
  private readonly oversizeNotified = new Set<string>();

  constructor(options: TrackerOptions) {
    this.options = options;
  }

  private get state() {
    return this.options.store.state;
  }

  private maxBytes(): number {
    const { maxFileSizeMB } = this.options.config;
    return maxFileSizeMB > 0 ? maxFileSizeMB * 1024 * 1024 : 0;
  }

  hasPendingOperation(): boolean {
    return this.pendingOperation !== undefined;
  }

  finishOperation(): void {
    this.pendingOperation = undefined;
  }

  /** Baseline snapshot so that the first operation can always be undone. */
  async ensureBaseline(): Promise<void> {
    if (this.state.snapshots.some((snapshot) => snapshot.kind === "baseline")) {
      return;
    }
    appendSnapshot(this.state, createBaselineSnapshot(this.options.now?.() ?? new Date()));
    this.options.store.markDirty();
    this.options.logger.log("created baseline snapshot");
  }

  /**
   * Capture the pre-edit state of a file the agent is about to modify.
   * Called from the `tool_call` event, before the tool executes.
   */
  async trackToolCall(toolName: string, input: unknown): Promise<void> {
    if (!this.options.config.enabled || !this.options.config.trackedTools.includes(toolName)) {
      return;
    }
    const rawPath = extractToolPath(input);
    if (rawPath === undefined) {
      return;
    }
    const absolutePath = resolveToolPath(this.options.cwd, rawPath);
    const storedPath = toStoredPath(this.options.cwd, absolutePath, this.options.platform);

    if (this.options.isHardExcluded?.(absolutePath) || this.options.matcher.isExcluded(absolutePath)) {
      this.options.logger.log(`skip excluded path=${storedPath}`);
      return;
    }
    if (this.state.trackedFiles.includes(storedPath)) {
      return;
    }

    const info = await lstatOrNull(absolutePath);
    if (info?.isSymbolicLink()) {
      this.options.logger.log(`skip symlink path=${storedPath}`);
      return;
    }
    const maxBytes = this.maxBytes();
    if (info && maxBytes > 0 && info.size > maxBytes) {
      if (!this.oversizeNotified.has(storedPath)) {
        this.oversizeNotified.add(storedPath);
        this.options.onNotice?.("notify.oversize", {
          mb: this.options.config.maxFileSizeMB,
          path: storedPath,
        });
      }
      this.options.logger.log(`skip oversize path=${storedPath} size=${info.size}`);
      return;
    }

    try {
      const record = await createBackup({
        backupsDir: this.options.paths.backupsDir,
        absolutePath,
        storedPath,
        version: 1,
        now: this.options.now?.(),
      });
      this.state.originals[storedPath] = record;
      this.state.trackedFiles.push(storedPath);
      this.options.store.markDirty();
      this.options.logger.log(`track path=${storedPath} version=1`);
    } catch (error) {
      this.options.onNotice?.("notify.backupSkipped", { path: storedPath, error: String(error) });
      this.options.logger.log(`backup failed path=${storedPath} error=${String(error)}`);
    }
  }

  /** Create the operation snapshot (before_agent_start). */
  async beginOperation(startLeafId: string | null): Promise<void> {
    if (this.pendingOperation !== undefined) {
      return;
    }
    const operationId = randomUUID();
    const snapshot: Snapshot = {
      id: randomUUID(),
      key: operationId,
      files: {},
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      kind: "operation",
    };
    snapshot.files = await this.captureTrackedFiles();
    appendSnapshot(this.state, snapshot);
    this.options.store.markDirty();
    this.pendingOperation = { snapshotId: snapshot.id, operationKey: operationId, startLeafId };
    this.enforceCapAndGc();
    this.options.logger.log(`operation snapshot id=${snapshot.id} files=${Object.keys(snapshot.files).length}`);
  }

  /** Drop the oldest snapshots and delete backups nothing references (docs §8). */
  private enforceCapAndGc(): void {
    const evicted = enforceSnapshotCap(
      this.state,
      this.options.config.maxSnapshotsPerSession,
      redoProtectedKeys(this.state),
    );
    if (evicted.length > 0) {
      this.options.store.markDirty();
      this.options.logger.log(`snapshot cap evicted=${evicted.length}`);
    }
    void deleteUnreferencedBackups(this.options.paths.backupsDir, collectReferencedBackups(this.state))
      .then((removed) => {
        if (removed > 0) {
          this.options.logger.log(`backup gc removed=${removed}`);
        }
      })
      .catch(() => {});
  }

  /** Bind the pending operation snapshot to the user message that started it. */
  bindOperation(branch: readonly BranchEntry[]): string | undefined {
    const pending = this.pendingOperation;
    if (pending === undefined) {
      return undefined;
    }
    const snapshot = this.state.snapshots.find((candidate) => candidate.id === pending.snapshotId);
    if (snapshot === undefined) {
      return undefined;
    }
    if (snapshot.key !== pending.operationKey) {
      return snapshot.key;
    }
    const startIndex = pending.startLeafId === null
      ? -1
      : branch.findIndex((entry) => entry.id === pending.startLeafId);
    const userEntry = branch.slice(startIndex + 1).find(isUserMessageEntry);
    if (userEntry === undefined) {
      return undefined;
    }
    snapshot.key = userEntry.id;
    this.options.store.markDirty();
    this.options.logger.log(`bound operation snapshot=${snapshot.id} entry=${userEntry.id}`);
    return userEntry.id;
  }

  /** Snapshot of the current tracked-file state, used as a redo target. */
  async createRedoPoint(): Promise<Snapshot> {
    const snapshot: Snapshot = {
      id: randomUUID(),
      key: randomUUID(),
      files: {},
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      kind: "redo-point",
    };
    snapshot.files = await this.captureTrackedFiles();
    appendSnapshot(this.state, snapshot);
    this.options.store.markDirty();
    this.options.logger.log(`redo-point snapshot key=${snapshot.key} files=${Object.keys(snapshot.files).length}`);
    return snapshot;
  }

  /** Current content records for every tracked file (reuse unchanged backups). */
  private async captureTrackedFiles(): Promise<Record<string, FileBackupRecord>> {
    const files: Record<string, FileBackupRecord> = {};
    for (const storedPath of this.state.trackedFiles) {
      const absolutePath = fromStoredPath(this.options.cwd, storedPath);
      const info = await lstatOrNull(absolutePath);
      const previous = latestRecordFor(this.state, storedPath);

      if (info?.isSymbolicLink()) {
        // Never follow links: keep the previous record so restore skips it.
        if (previous !== undefined) {
          files[storedPath] = previous;
        }
        continue;
      }

      if (!info) {
        files[storedPath] = {
          backupFileName: null,
          version: (previous?.version ?? 0) + 1,
          backupTime: (this.options.now?.() ?? new Date()).toISOString(),
        };
        continue;
      }

      if (previous && previous.backupFileName !== null && (await this.matchesBackup(absolutePath, previous))) {
        files[storedPath] = previous;
        continue;
      }

      files[storedPath] = await createBackup({
        backupsDir: this.options.paths.backupsDir,
        absolutePath,
        storedPath,
        version: (previous?.version ?? 0) + 1,
        now: this.options.now?.(),
      });
    }
    return files;
  }

  private async matchesBackup(absolutePath: string, record: FileBackupRecord): Promise<boolean> {
    if (record.backupFileName === null) {
      return false;
    }
    const backupPath = path.join(this.options.paths.backupsDir, record.backupFileName);
    const [currentInfo, backupInfo] = await Promise.all([lstatOrNull(absolutePath), lstatOrNull(backupPath)]);
    if (!currentInfo || !backupInfo) {
      return false;
    }
    if (currentInfo.size !== backupInfo.size) {
      return false;
    }
    // The backup was created by reading this file, so a strictly older mtime
    // means the content still matches (same shortcut as CC fk2). Equal
    // timestamps must fall through to a content comparison because the file
    // may have been rewritten within the same clock tick.
    if (currentInfo.mtimeMs < backupInfo.mtimeMs) {
      return true;
    }
    const backup = await readBackup(this.options.paths.backupsDir, record.backupFileName);
    if (backup === undefined) {
      return false;
    }
    try {
      const current = await readFile(absolutePath);
      return current.length === backup.length && current.equals(backup);
    } catch {
      return false;
    }
  }
}
