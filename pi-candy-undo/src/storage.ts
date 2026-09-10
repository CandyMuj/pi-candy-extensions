/**
 * 文件系统层（docs/design.md §4、§8）。
 *
 * 布局：
 *   <storageDir>/<sessionId>/state.json
 *   <storageDir>/<sessionId>/backups/<sha256(storedPath)[:16]>@v<N>
 *   <storageDir>/undo.log
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { FileBackupRecord, UndoState } from "./types.ts";

export interface StoragePaths {
  root: string;
  sessionDir: string;
  stateFile: string;
  backupsDir: string;
  logFile: string;
}

export function buildStoragePaths(root: string, sessionId: string): StoragePaths {
  const sessionDir = path.join(root, sessionId);
  return {
    root,
    sessionDir,
    stateFile: path.join(sessionDir, "state.json"),
    backupsDir: path.join(sessionDir, "backups"),
    logFile: path.join(root, "undo.log"),
  };
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function lstatOrNull(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch {
    return undefined;
  }
}

export async function statOrNull(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

export async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isValidState(value: unknown): value is UndoState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<UndoState>;
  return (
    candidate.version === 1 &&
    typeof candidate.sessionId === "string" &&
    Array.isArray(candidate.snapshots) &&
    typeof candidate.originals === "object" &&
    candidate.originals !== null &&
    Array.isArray(candidate.trackedFiles) &&
    Array.isArray(candidate.redo)
  );
}

export async function readStateFile(stateFile: string): Promise<UndoState | undefined> {
  const parsed = await readJsonFile<unknown>(stateFile);
  return isValidState(parsed) ? parsed : undefined;
}

export async function writeStateFile(stateFile: string, state: UndoState): Promise<void> {
  await writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function backupFileName(storedPath: string, version: number): string {
  const hash = createHash("sha256").update(storedPath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

export interface CreateBackupOptions {
  backupsDir: string;
  absolutePath: string;
  storedPath: string;
  version: number;
  now?: Date;
}

/**
 * 把 `absolutePath` 的当前内容复制为不可变备份文件。
 * 文件不存在时返回 `backupFileName: null` 的记录。
 */
export async function createBackup(options: CreateBackupOptions): Promise<FileBackupRecord> {
  const backupTime = (options.now ?? new Date()).toISOString();
  const info = await statOrNull(options.absolutePath);
  if (!info || !info.isFile()) {
    return { backupFileName: null, version: options.version, backupTime };
  }

  const name = backupFileName(options.storedPath, options.version);
  const target = path.join(options.backupsDir, name);
  if (await pathExists(target)) {
    return { backupFileName: name, version: options.version, backupTime };
  }

  const content = await readFile(options.absolutePath);
  await writeFileAtomic(target, content);
  try {
    await chmod(target, info.mode & 0o777);
  } catch {
    // Mode preservation is best-effort (meaningless on Windows).
  }
  return { backupFileName: name, version: options.version, backupTime };
}

export async function readBackup(backupsDir: string, fileName: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path.join(backupsDir, fileName));
  } catch {
    return undefined;
  }
}

export async function listBackupFiles(backupsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(backupsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 删除不再被任何快照或 originals 引用的备份文件。 */
export async function deleteUnreferencedBackups(
  backupsDir: string,
  referenced: ReadonlySet<string>,
): Promise<number> {
  const files = await listBackupFiles(backupsDir);
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) {
      continue;
    }
    try {
      await unlink(path.join(backupsDir, file));
      removed += 1;
    } catch {
      // Ignore: another process may have removed it already.
    }
  }
  return removed;
}

export interface CleanupResult {
  removed: string[];
  errors: string[];
}

/** 删除 mtime 早于 maxAgeMs 的会话目录（docs §8）。 */
export async function cleanupExpiredSessions(
  root: string,
  maxAgeMs: number,
  keepSessionId: string,
  now: number = Date.now(),
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], errors: [] };
  if (maxAgeMs <= 0) {
    return result;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepSessionId) {
      continue;
    }
    const target = path.join(root, entry.name);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs <= maxAgeMs) {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      result.removed.push(entry.name);
    } catch (error) {
      result.errors.push(`${entry.name}: ${String(error)}`);
    }
  }
  return result;
}

export interface MigrationResult {
  migrated: boolean;
  linked: number;
  copied: number;
  stateCopied: boolean;
}

/**
 * 从上一个会话目录复制状态并硬链接备份（fork/clone）。
 * 备份不可变，因此硬链接是安全的；复制作为降级方案。
 */
export async function migrateSessionData(
  previousSessionDir: string,
  nextPaths: StoragePaths,
  sessionId: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: false, linked: 0, copied: 0, stateCopied: false };
  if (path.resolve(previousSessionDir) === path.resolve(nextPaths.sessionDir)) {
    return result;
  }
  if (!(await pathExists(previousSessionDir))) {
    return result;
  }

  await mkdir(nextPaths.backupsDir, { recursive: true });

  const previousState = await readStateFile(path.join(previousSessionDir, "state.json"));
  if (previousState) {
    const migratedState: UndoState = {
      ...previousState,
      sessionId,
      redo: [],
    };
    await writeStateFile(nextPaths.stateFile, migratedState);
    result.stateCopied = true;
  }

  const previousBackupsDir = path.join(previousSessionDir, "backups");
  for (const file of await listBackupFiles(previousBackupsDir)) {
    const source = path.join(previousBackupsDir, file);
    const target = path.join(nextPaths.backupsDir, file);
    if (await pathExists(target)) {
      continue;
    }
    try {
      await link(source, target);
      result.linked += 1;
    } catch {
      try {
        await copyFile(source, target);
        result.copied += 1;
      } catch {
        // Ignore unreadable backup files.
      }
    }
  }

  result.migrated = result.stateCopied || result.linked + result.copied > 0;
  return result;
}

/** 从会话 JSONL 文件的首行读取会话 id。 */
export async function readSessionIdFromFile(sessionFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(sessionFile, "utf8");
    const firstLine = content.split("\n", 1)[0];
    if (!firstLine) {
      return undefined;
    }
    const header: unknown = JSON.parse(firstLine);
    if (typeof header === "object" && header !== null && typeof (header as { id?: unknown }).id === "string") {
      return (header as { id: string }).id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 读取会话头中记录的 cwd（用于守卫 fork 迁移）。 */
export async function readSessionCwdFromFile(sessionFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(sessionFile, "utf8");
    const firstLine = content.split("\n", 1)[0];
    if (!firstLine) {
      return undefined;
    }
    const header: unknown = JSON.parse(firstLine);
    if (typeof header === "object" && header !== null && typeof (header as { cwd?: unknown }).cwd === "string") {
      return (header as { cwd: string }).cwd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
