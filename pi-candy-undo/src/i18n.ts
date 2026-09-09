/**
 * Minimal i18n for user-facing strings (docs/design.md §7 `language`).
 * Supported: zh (default) and en. Adding a language = add a column here.
 */

import type { Language } from "./types.ts";

export const MESSAGES = {
  "picker.title": {
    zh: "回退到该消息之前",
    en: "Rewind to before",
  },
  "picker.noChanges": {
    zh: "无文件改动",
    en: "No code changes",
  },
  "picker.filesChanged": {
    zh: "{files} 个文件",
    en: "{files} file(s)",
  },
  "picker.lines": {
    zh: "+{insertions} -{deletions}",
    en: "+{insertions} -{deletions}",
  },
  "picker.skipped": {
    zh: "{count} 个链接已跳过",
    en: "{count} link(s) skipped",
  },
  "action.title": {
    zh: "选择回退方式",
    en: "Choose what to restore",
  },
  "action.both": {
    zh: "恢复代码和对话",
    en: "Restore code and conversation",
  },
  "action.conversation": {
    zh: "仅恢复对话",
    en: "Restore conversation",
  },
  "action.code": {
    zh: "仅恢复代码",
    en: "Restore code",
  },
  "action.summarize": {
    zh: "摘要并回退对话",
    en: "Summarize",
  },
  "action.summarizeCustom": {
    zh: "自定义摘要并回退对话",
    en: "Summarize with custom prompt",
  },
  "action.nevermind": {
    zh: "算了",
    en: "Never mind",
  },
  "summary.inputTitle": {
    zh: "自定义摘要指令",
    en: "Custom summarization instructions",
  },
  "notify.disabled": {
    zh: "pi-candy-undo 已禁用（candyUndo.enabled = false）",
    en: "pi-candy-undo is disabled (candyUndo.enabled = false)",
  },
  "notify.noUI": {
    zh: "当前模式不支持交互式回退",
    en: "Undo is unavailable in this mode",
  },
  "notify.nothingToUndo": {
    zh: "没有可回退的消息",
    en: "Nothing to undo",
  },
  "notify.nothingToRedo": {
    zh: "没有可重做的操作",
    en: "Nothing to redo",
  },
  "notify.undoCompleteBoth": {
    zh: "已回退：恢复 {count} 个文件，对话已回退到该消息之前",
    en: "Undo complete: {count} file(s) restored, conversation rewound",
  },
  "notify.undoCompleteCode": {
    zh: "已回退：恢复 {count} 个文件",
    en: "Undo complete: {count} file(s) restored",
  },
  "notify.undoCompleteConversation": {
    zh: "对话已回退到该消息之前",
    en: "Conversation rewound to before that message",
  },
  "notify.undoNoChanges": {
    zh: "文件已处于目标状态，未做改动",
    en: "Files are already at the target state; nothing changed",
  },
  "notify.redoCompleteBoth": {
    zh: "已重做：恢复 {count} 个文件，对话已还原",
    en: "Redo complete: {count} file(s) restored, conversation restored",
  },
  "notify.redoCompleteCode": {
    zh: "已重做：恢复 {count} 个文件",
    en: "Redo complete: {count} file(s) restored",
  },
  "notify.redoCompleteConversation": {
    zh: "对话已还原",
    en: "Conversation restored",
  },
  "notify.undoCancelled": {
    zh: "已取消回退",
    en: "Undo cancelled",
  },
  "notify.redoCancelled": {
    zh: "已取消重做",
    en: "Redo cancelled",
  },
  "notify.restoreFailed": {
    zh: "文件恢复失败，已中止：{details}",
    en: "Workspace restore failed; aborted: {details}",
  },
  "notify.restoreFailedHint": {
    zh: "请关闭占用这些文件的程序后重试",
    en: "Close any program using these files, then retry",
  },
  "notify.redoStale": {
    zh: "该重做记录已失效，已丢弃",
    en: "The redo entry is no longer valid and was discarded",
  },
  "notify.migrated": {
    zh: "已从上一个会话迁移撤销历史（{count} 个备份）",
    en: "Undo history migrated from the previous session ({count} backup(s))",
  },
  "notify.oversize": {
    zh: "文件超过 {mb}MB，未纳入撤销跟踪：{path}",
    en: "File exceeds {mb}MB and is not tracked for undo: {path}",
  },
  "notify.storageError": {
    zh: "撤销存储不可用：{error}",
    en: "Undo storage is unavailable: {error}",
  },
  "notify.configWarning": {
    zh: "candyUndo 配置存在问题：{details}",
    en: "candyUndo configuration has issues: {details}",
  },
  "notify.backupSkipped": {
    zh: "跳过备份（{error}）：{path}",
    en: "Skipped backup ({error}): {path}",
  },
  "note.manualEdits": {
    zh: "回退不会影响手动修改或通过 bash 修改的文件",
    en: "Rewinding does not affect files edited manually or via bash",
  },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function createTranslator(language: Language): Translator {
  return (key, params) => format(MESSAGES[key][language], params);
}

export function messageKeys(): MessageKey[] {
  return Object.keys(MESSAGES) as MessageKey[];
}
