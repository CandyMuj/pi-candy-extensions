/**
 * 跟踪层（docs/design.md §5）。
 *
 * - `trackToolCall` 在被跟踪工具写入之前运行：文件首次出现时，把编辑前
 *   内容存入 `originals`（CC v1 语义）。
 * - `beginOperation` 在 agent 操作开始前运行，把所有跟踪文件的当前内容
 *   记录为操作快照。
 * - `bindOperation` 把该快照绑定到开启这次操作的用户消息条目。
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
  /** 硬排除（存储目录及其内部的一切）。 */
  isHardExcluded?: (absolutePath: string) => boolean;
  /** 向用户提示（超大文件、备份失败）。 */
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

  /** baseline 快照，保证首个操作总能被撤销。 */
  async ensureBaseline(): Promise<void> {
    if (this.state.snapshots.some((snapshot) => snapshot.kind === "baseline")) {
      return;
    }
    appendSnapshot(this.state, createBaselineSnapshot(this.options.now?.() ?? new Date()));
    this.options.store.markDirty();
    this.options.logger.log("created baseline snapshot");
  }

  /**
   * 捕获 agent 即将修改的文件的编辑前状态。
   * 由 `tool_call` 事件在工具执行前调用。
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

  /** 创建操作快照（before_agent_start）。 */
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

  /** 丢弃最旧的快照，并删除不再被引用的备份（docs §8）。 */
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

  /** 把待定操作快照绑定到开启它的用户消息。 */
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

  /** 当前跟踪文件状态的快照，用作 redo 目标。 */
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

  /** 每个跟踪文件的当前内容记录（内容未变则复用备份）。 */
  private async captureTrackedFiles(): Promise<Record<string, FileBackupRecord>> {
    const files: Record<string, FileBackupRecord> = {};
    for (const storedPath of this.state.trackedFiles) {
      const absolutePath = fromStoredPath(this.options.cwd, storedPath);
      const info = await lstatOrNull(absolutePath);
      const previous = latestRecordFor(this.state, storedPath);

      if (info?.isSymbolicLink()) {
        // 永不跟随链接：保留上一条记录，让恢复阶段跳过它。
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
    // 备份是读取该文件后创建的，因此严格更早的 mtime
    // 说明内容仍然一致（与 CC fk2 相同的快捷判断）。
    // 时间戳相等时必须继续做内容比较，因为文件
    // 可能在同一时间刻度内被重写。
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
