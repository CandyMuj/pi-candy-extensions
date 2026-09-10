/**
 * 恢复层（docs/design.md §3 恢复算法、§9 可靠性）。
 *
 * 恢复是绝对且幂等的：文件已与备份一致时跳过（CC `fk2` 语义）。
 * 符号链接与硬链接永远不会被写入或删除（CC 2.1.216 防护）。
 */

import { diffLines } from "diff";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fromStoredPath } from "./paths.ts";
import type { StateStore } from "./state.ts";
import { readBackup, lstatOrNull, type StoragePaths } from "./storage.ts";
import type {
  FileBackupRecord,
  Logger,
  RestoreFailure,
  RestoreResult,
  RestoreStats,
  Snapshot,
  UndoConfig,
} from "./types.ts";

const RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface RestoreDeps {
  cwd: string;
  config: UndoConfig;
  store: StateStore;
  paths: StoragePaths;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export class RestoreError extends Error {
  failures: RestoreFailure[];

  constructor(failures: RestoreFailure[]) {
    super(failures.map((failure) => `${failure.path}: ${failure.error}`).join("; "));
    this.name = "RestoreError";
    this.failures = failures;
  }
}

function isTransientError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "EMFILE" || code === "ENFILE";
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientError(error)) {
        throw error;
      }
      await sleep(delay);
    }
  }
}

/** 跟踪文件的目标记录：优先快照记录，否则回落到首次出现的原始状态。 */
export function resolveRecord(
  state: StateStore["state"],
  target: Snapshot,
  storedPath: string,
): FileBackupRecord | undefined {
  const fromSnapshot = target.files[storedPath];
  if (fromSnapshot !== undefined) {
    return fromSnapshot;
  }
  return state.originals[storedPath];
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function countLines(value: string): number {
  if (value === "") {
    return 0;
  }
  const lines = value.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

function diffCounts(current: Buffer, target: Buffer): { insertions: number; deletions: number } {
  if (looksBinary(current) || looksBinary(target)) {
    return { insertions: 1, deletions: 1 };
  }
  const parts = diffLines(current.toString("utf8"), target.toString("utf8"));
  let insertions = 0;
  let deletions = 0;
  for (const part of parts) {
    const lines = typeof part.count === "number" ? part.count : countLines(part.value);
    if (part.added) {
      insertions += lines;
    } else if (part.removed) {
      deletions += lines;
    }
  }
  return { insertions, deletions };
}

interface FileState {
  exists: boolean;
  symlink: boolean;
  hardLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

async function inspect(absolutePath: string): Promise<FileState> {
  const info = await lstatOrNull(absolutePath);
  if (!info) {
    return { exists: false, symlink: false, hardLink: false, size: 0, mode: 0, mtimeMs: 0 };
  }
  return {
    exists: true,
    symlink: info.isSymbolicLink(),
    hardLink: info.nlink > 1,
    size: info.size,
    mode: info.mode & 0o777,
    mtimeMs: info.mtimeMs,
  };
}

/**
 * fk2 等价判断：`absolutePath` 与备份内容是否不同？
 * `trustMtime` 在文件早于备份时短路（仅用于展示统计）。
 */
async function needsRestore(
  absolutePath: string,
  backupPath: string,
  trustMtime: boolean,
): Promise<boolean> {
  const [current, backup] = await Promise.all([inspect(absolutePath), inspect(backupPath)]);
  if (!current.exists) {
    return true;
  }
  if (!backup.exists) {
    return true;
  }
  if (current.mode !== backup.mode || current.size !== backup.size) {
    return true;
  }
  if (trustMtime && current.mtimeMs < backup.mtimeMs) {
    return false;
  }
  const [currentContent, backupContent] = await Promise.all([
    readFile(absolutePath),
    readFile(backupPath),
  ]);
  return !currentContent.equals(backupContent);
}

function backupPath(deps: RestoreDeps, record: FileBackupRecord): string | undefined {
  return record.backupFileName === null ? undefined : path.join(deps.paths.backupsDir, record.backupFileName);
}

/** 供选择器与确认菜单使用的预演（dry-run）统计。 */
export async function computeStats(deps: RestoreDeps, target: Snapshot): Promise<RestoreStats> {
  const stats: RestoreStats = { filesChanged: [], insertions: 0, deletions: 0, skipped: [] };
  for (const storedPath of deps.store.state.trackedFiles) {
    const record = resolveRecord(deps.store.state, target, storedPath);
    if (record === undefined) {
      continue;
    }
    const absolutePath = fromStoredPath(deps.cwd, storedPath);
    const info = await inspect(absolutePath);
    if (info.symlink || info.hardLink) {
      stats.skipped.push(storedPath);
      continue;
    }

    if (record.backupFileName === null) {
      if (!info.exists) {
        continue;
      }
      const current = await readFile(absolutePath).catch(() => undefined);
      if (current === undefined) {
        stats.skipped.push(storedPath);
        continue;
      }
      stats.filesChanged.push(storedPath);
      stats.deletions += looksBinary(current) ? 1 : countLines(current.toString("utf8"));
      continue;
    }

    const targetPath = backupPath(deps, record);
    if (targetPath === undefined) {
      continue;
    }
    let differs: boolean;
    try {
      differs = await needsRestore(absolutePath, targetPath, true);
    } catch {
      stats.skipped.push(storedPath);
      continue;
    }
    if (!differs) {
      continue;
    }
    stats.filesChanged.push(storedPath);
    const backupContent = await readBackup(deps.paths.backupsDir, record.backupFileName).catch(() => undefined);
    const currentContent = await readFile(absolutePath).catch(() => Buffer.alloc(0));
    if (backupContent === undefined) {
      continue;
    }
    const counts = diffCounts(currentContent, backupContent);
    stats.insertions += counts.insertions;
    stats.deletions += counts.deletions;
  }
  return stats;
}

/**
 * 把所有跟踪文件恢复到目标快照状态。
 * 任一文件恢复失败时抛出 RestoreError。
 */
export async function restoreSnapshot(deps: RestoreDeps, target: Snapshot): Promise<RestoreResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const result: RestoreResult = { changed: [], skipped: [], unchanged: 0 };
  const failures: RestoreFailure[] = [];

  for (const storedPath of deps.store.state.trackedFiles) {
    const record = resolveRecord(deps.store.state, target, storedPath);
    if (record === undefined) {
      continue;
    }
    const absolutePath = fromStoredPath(deps.cwd, storedPath);

    try {
      const info = await inspect(absolutePath);
      if (info.symlink || info.hardLink) {
        result.skipped.push(storedPath);
        deps.logger.log(`restore skipped link path=${storedPath}`);
        continue;
      }

      if (record.backupFileName === null) {
        if (!info.exists) {
          continue;
        }
        await withRetry(() => unlink(absolutePath), sleep);
        result.changed.push(storedPath);
        deps.logger.log(`restore deleted path=${storedPath}`);
        continue;
      }

      const source = backupPath(deps, record);
      if (source === undefined) {
        continue;
      }
      if (!(await needsRestore(absolutePath, source, false))) {
        result.unchanged += 1;
        continue;
      }
      const content = await readFile(source);
      await withRetry(async () => {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content);
        try {
          const backupInfo = await lstat(source);
          await chmod(absolutePath, backupInfo.mode & 0o777);
        } catch {
          // Mode preservation is best-effort.
        }
      }, sleep);
      result.changed.push(storedPath);
      deps.logger.log(`restore wrote path=${storedPath} from=${record.backupFileName}`);
    } catch (error) {
      failures.push({ path: storedPath, error: String(error) });
      deps.logger.log(`restore failed path=${storedPath} error=${String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new RestoreError(failures);
  }
  return result;
}
