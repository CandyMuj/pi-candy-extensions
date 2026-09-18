/**
 * 会话 entry 公共工具：多工具共享的 entry 形状与纯文本提取。
 * 由 click-cursor / session-title / transcript-jump 三处重复实现收敛而来，
 * 新工具一律从这里引用，不要各自再定义（保持单一实现）。
 */

/** 会话 entry 结构子集（真实结构为 { type: "message", message: { role, content } }）；不加索引签名以保持 pi SDK 的 SessionEntry 可赋值 */
export interface EntryLike {
  type?: string;
  id?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
  };
}

/** 提取消息纯文本（跳过 thinking/tool 等非文本块） */
export function entryText(e: EntryLike): string {
  if (e.type && e.type !== "message") return ""; // 跳过 compaction 等非消息 entry
  const m = e.message;
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** 是否为用户消息 entry（非 message 类型一律视为否） */
export function isUserMessage(e: EntryLike): boolean {
  if (e.type && e.type !== "message") return false;
  return e.message?.role === "user";
}
