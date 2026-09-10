/**
 * /undo 与 /redo 的命令流程（docs/design.md §6）。
 */

import { collectReferencedBackups, peekRedo, popRedo, pushRedo } from "./state.ts";
import { deleteUnreferencedBackups } from "./storage.ts";
import { computeStats, RestoreError, restoreSnapshot } from "./restore.ts";
import type { CommandApi, UndoSession } from "./session.ts";
import type { BranchEntry, RedoItem, RestoreStats, Snapshot } from "./types.ts";

export interface UserMessage {
  entry: BranchEntry;
  text: string;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text: string } => {
        return (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        );
      })
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** 分支上的用户消息，最新的在前，受 pickerLimit 限制。 */
export function collectUserMessages(branch: readonly BranchEntry[], limit: number): UserMessage[] {
  const messages: UserMessage[] = [];
  for (const entry of branch) {
    if (entry.type === "message" && entry.message?.role === "user") {
      messages.push({ entry, text: contentToText(entry.message.content) });
    }
  }
  messages.reverse();
  return limit > 0 ? messages.slice(0, limit) : messages;
}

/** 用户消息对应的快照：优先绑定的快照，否则最近更早的快照，最后回落到 baseline。 */
export function resolveTargetSnapshot(
  snapshots: readonly Snapshot[],
  branch: readonly BranchEntry[],
  entryId: string,
): Snapshot | undefined {
  const byKey = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    byKey.set(snapshot.key, snapshot);
  }
  const parents = new Map<string, string | null>();
  for (const entry of branch) {
    parents.set(entry.id, entry.parentId);
  }

  let current: string | null | undefined = entryId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const snapshot = byKey.get(current);
    if (snapshot) {
      return snapshot;
    }
    current = parents.get(current) ?? null;
  }
  return snapshots.find((snapshot) => snapshot.kind === "baseline");
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function formatStats(session: UndoSession, stats: RestoreStats): string {
  if (stats.filesChanged.length === 0) {
    return session.t("picker.noChanges");
  }
  const files = session.t("picker.filesChanged", { files: stats.filesChanged.length });
  const lines = session.t("picker.lines", {
    insertions: stats.insertions,
    deletions: stats.deletions,
  });
  const skipped = stats.skipped.length > 0 ? ` · ${session.t("picker.skipped", { count: stats.skipped.length })}` : "";
  return `${files} · ${lines}${skipped}`;
}

async function runMaintenance(session: UndoSession): Promise<void> {
  try {
    const referenced = collectReferencedBackups(session.store.state);
    const removed = await deleteUnreferencedBackups(session.paths.backupsDir, referenced);
    if (removed > 0) {
      session.logger.log(`gc removed=${removed}`);
    }
  } catch (error) {
    session.logger.log(`gc failed error=${String(error)}`);
  }
  await session.store.flush();
}

function pushRedoItem(
  session: UndoSession,
  type: RedoItem["type"],
  restoreKey: string | null,
  oldLeafId: string | null,
): void {
  pushRedo(
    session.store.state,
    { type, restoreKey, oldLeafId, createdAt: new Date().toISOString() },
    session.config.maxRedoStackSize,
  );
  session.store.markDirty();
}

type Action = "both" | "conversation" | "code" | "summarize" | "summarize-custom" | "nevermind";

/** 以受限并发对一组元素执行异步任务。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runUndo(session: UndoSession, cmd: CommandApi): Promise<void> {
  if (!session.active) {
    session.notifyKey(session.config.enabled ? "notify.noUI" : "notify.disabled", undefined, "warning");
    return;
  }
  await cmd.waitForIdle();

  const branch = cmd.getBranch();
  const messages = collectUserMessages(branch, session.config.pickerLimit);
  if (messages.length === 0) {
    session.notifyKey("notify.nothingToUndo", undefined, "info");
    return;
  }

  const statsBySnapshotId = new Map<string, RestoreStats>();
  const targets = new Map<string, Snapshot>();
  const statsFor = async (snapshot: Snapshot): Promise<RestoreStats> => {
    const cached = statsBySnapshotId.get(snapshot.id);
    if (cached) {
      return cached;
    }
    const stats = await computeStats(session, snapshot);
    statsBySnapshotId.set(snapshot.id, stats);
    return stats;
  };

  const options: string[] = [];
  const optionToMessage = new Map<string, UserMessage>();
  const prepared = await mapLimit(messages, 8, async (message) => {
    const target = resolveTargetSnapshot(session.store.state.snapshots, branch, message.entry.id);
    const stats: RestoreStats = target
      ? await statsFor(target)
      : { filesChanged: [], insertions: 0, deletions: 0, skipped: [] };
    return { message, target, stats };
  });
  for (const [index, item] of prepared.entries()) {
    if (item.target) {
      targets.set(item.message.entry.id, item.target);
    }
    const label = `${index + 1}. ${truncate(item.message.text, 60)} · ${formatStats(session, item.stats)}`;
    options.push(label);
    optionToMessage.set(label, item.message);
  }

  const picked = await cmd.select(session.t("picker.title"), options);
  if (picked === undefined) {
    return;
  }
  const message = optionToMessage.get(picked);
  if (!message) {
    return;
  }
  const target = targets.get(message.entry.id);
  if (!target) {
    session.notifyKey("notify.nothingToUndo", undefined, "info");
    return;
  }
  const stats = await statsFor(target);
  const hasChanges = stats.filesChanged.length > 0;

  const actions: Array<{ action: Action; label: string }> = [];
  if (hasChanges) {
    actions.push({ action: "both", label: `${session.t("action.both")} (${formatStats(session, stats)})` });
    actions.push({ action: "conversation", label: session.t("action.conversation") });
    actions.push({ action: "code", label: `${session.t("action.code")} (${formatStats(session, stats)})` });
  } else {
    actions.push({ action: "conversation", label: session.t("action.conversation") });
  }
  actions.push({ action: "summarize", label: session.t("action.summarize") });
  actions.push({ action: "summarize-custom", label: session.t("action.summarizeCustom") });
  actions.push({ action: "nevermind", label: session.t("action.nevermind") });

  const actionLabels = new Map<string, Action>();
  for (const item of actions) {
    actionLabels.set(item.label, item.action);
  }

  const chosen = await cmd.select(
    `${session.t("action.title")}\n${session.t("note.manualEdits")}`,
    actions.map((item) => item.label),
  );
  if (chosen === undefined) {
    return;
  }
  const action = actionLabels.get(chosen);
  if (action === undefined || action === "nevermind") {
    return;
  }

  const oldLeafId = cmd.getLeafId();
  let restoredKey: string | null = null;
  let changedCount = 0;
  let alreadyAtTarget = false;
  let navigationOldLeafId: string | null = null;

  if (action === "code" || action === "both") {
    const redoPoint = await session.tracker.createRedoPoint();
    try {
      const result = await restoreSnapshot(session, target);
      changedCount = result.changed.length;
      alreadyAtTarget = result.changed.length === 0;
      restoredKey = redoPoint.key;
      session.logger.log(
        `undo restore target=${target.id} changed=${result.changed.length} unchanged=${result.unchanged} skipped=${result.skipped.length}`,
      );
    } catch (error) {
      // 丢弃未使用的 redo-point 快照，并在导航前中止。
      session.store.state.snapshots = session.store.state.snapshots.filter(
        (snapshot) => snapshot.id !== redoPoint.id,
      );
      session.store.markDirty();
      const details = error instanceof RestoreError
        ? error.failures.map((failure) => `${failure.path} (${failure.error})`).join("; ")
        : String(error);
      session.notifyKey("notify.restoreFailed", { details }, "error");
      session.notifyKey("notify.restoreFailedHint", undefined, "warning");
      await runMaintenance(session);
      return;
    }
  }

  if (action !== "code") {
    let customInstructions: string | undefined;
    if (action === "summarize-custom") {
      const input = await cmd.input(session.t("summary.inputTitle"));
      if (input === undefined) {
        return;
      }
      customInstructions = input;
    }
    const summarize = action === "summarize" || action === "summarize-custom";
    const result = await cmd.navigateTree(message.entry.id, { summarize, customInstructions });
    if (result.cancelled) {
      if (restoredKey) {
        pushRedoItem(session, "code", restoredKey, null);
        await runMaintenance(session);
        session.notifyKey("notify.undoCompleteCode", { count: changedCount }, "warning");
      } else {
        session.notifyKey("notify.undoCancelled", undefined, "info");
      }
      return;
    }
    navigationOldLeafId = oldLeafId;
  }

  const type: RedoItem["type"] = restoredKey && navigationOldLeafId ? "both" : restoredKey ? "code" : "conversation";
  pushRedoItem(session, type, restoredKey, navigationOldLeafId);
  await runMaintenance(session);

  if (restoredKey && navigationOldLeafId) {
    session.notifyKey("notify.undoCompleteBoth", { count: changedCount }, "info");
  } else if (restoredKey) {
    if (alreadyAtTarget) {
      session.notifyKey("notify.undoNoChanges", undefined, "info");
    } else {
      session.notifyKey("notify.undoCompleteCode", { count: changedCount }, "info");
    }
  } else {
    session.notifyKey("notify.undoCompleteConversation", undefined, "info");
  }
}

export async function runRedo(session: UndoSession, cmd: CommandApi): Promise<void> {
  if (!session.active) {
    session.notifyKey(session.config.enabled ? "notify.noUI" : "notify.disabled", undefined, "warning");
    return;
  }
  await cmd.waitForIdle();

  const item = peekRedo(session.store.state);
  if (!item) {
    session.notifyKey("notify.nothingToRedo", undefined, "info");
    return;
  }

  const target = item.restoreKey
    ? session.store.state.snapshots.find((snapshot) => snapshot.key === item.restoreKey)
    : undefined;
  const restoreKey = item.restoreKey && target ? item.restoreKey : null;
  const oldLeafId = item.oldLeafId && cmd.getEntry(item.oldLeafId) ? item.oldLeafId : null;
  if (!restoreKey && !oldLeafId) {
    popRedo(session.store.state);
    session.store.markDirty();
    session.notifyKey("notify.redoStale", undefined, "warning");
    return;
  }

  let changedCount = 0;
  if (restoreKey && target) {
    try {
      const result = await restoreSnapshot(session, target);
      changedCount = result.changed.length;
      session.logger.log(`redo restore changed=${result.changed.length} unchanged=${result.unchanged}`);
    } catch (error) {
      const details = error instanceof RestoreError
        ? error.failures.map((failure) => `${failure.path} (${failure.error})`).join("; ")
        : String(error);
      session.notifyKey("notify.restoreFailed", { details }, "error");
      session.notifyKey("notify.restoreFailedHint", undefined, "warning");
      return;
    }
  }

  let navigated = false;
  if (oldLeafId) {
    const result = await cmd.navigateTree(oldLeafId, { summarize: false });
    if (result.cancelled) {
      session.notifyKey("notify.redoCancelled", undefined, "info");
      return;
    }
    navigated = true;
  }

  popRedo(session.store.state);
  session.store.markDirty();
  await runMaintenance(session);

  if (restoreKey && navigated) {
    session.notifyKey("notify.redoCompleteBoth", { count: changedCount }, "info");
  } else if (restoreKey) {
    session.notifyKey("notify.redoCompleteCode", { count: changedCount }, "info");
  } else {
    session.notifyKey("notify.redoCompleteConversation", undefined, "info");
  }
}
