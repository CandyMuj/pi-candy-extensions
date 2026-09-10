/**
 * pi-candy-undo 的共享数据类型。
 *
 * 存储模型（见 docs/design.md §3）：
 * - 快照记录某一时刻所有跟踪文件的状态。
 * - 备份是不可变的内容副本，记录只是对它们的引用。
 * - `originals` 保存每个文件首次出现时的状态（CC v1 语义）。
 */

export type SnapshotKind = "baseline" | "operation" | "redo-point";

/** 对不可变备份文件的引用（或表示“文件当时不存在”）。 */
export interface FileBackupRecord {
  /** 会话备份目录中的备份文件名；null = 文件当时不存在。 */
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface Snapshot {
  /** 稳定的内部 id（uuid），永不改变。 */
  id: string;
  /**
   * 绑定目标：该快照所属的用户消息 entry id。
   * baseline 快照使用固定哨兵值；操作进行中则暂时持有操作 id，
   * 直到完成绑定。
   */
  key: string;
  files: Record<string, FileBackupRecord>;
  createdAt: string;
  kind: SnapshotKind;
}

export type RedoKind = "code" | "conversation" | "both";

export interface RedoItem {
  type: RedoKind;
  /** redo-point 快照的 key（仅 code/both）。 */
  restoreKey: string | null;
  /** undo 导航前的 leaf id（仅 conversation/both）。 */
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
  /** 0 = 不限制。 */
  maxFileSizeMB: number;
  /** 最小 1。 */
  maxSnapshotsPerSession: number;
  /** 0 = 禁用 redo。 */
  maxRedoStackSize: number;
  /** 0 = 禁用自动清理。 */
  cleanupPeriodDays: number;
  /** 最小 1。 */
  pickerLimit: number;
  log: boolean;
}

export interface RestoreStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
  /** 因符号链接/硬链接而跳过的路径。 */
  skipped: string[];
}

export interface RestoreFailure {
  path: string;
  error: string;
}

export interface RestoreResult {
  changed: string[];
  skipped: string[];
  /** 比较后发现已处于目标状态（幂等无操作）的文件数。 */
  unchanged: number;
}

/** 插件用到的会话条目最小结构。 */
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
