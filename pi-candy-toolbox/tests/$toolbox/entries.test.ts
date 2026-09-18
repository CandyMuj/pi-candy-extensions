/**
 * core/entries.ts：会话 entry 公共工具（entryText / isUserMessage / EntryLike）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { entryText, isUserMessage, type EntryLike } from "../../extensions/core/entries.ts";

const user = (content: string | Array<{ type: string; text?: string }>): EntryLike => ({
  type: "message",
  message: { role: "user", content },
});

test("entryText extracts plain text from string or text blocks", () => {
  assert.equal(entryText(user("直接文本")), "直接文本");
  assert.equal(
    entryText(user([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }])),
    "第一段\n第二段",
  );
  assert.equal(entryText(user([])), "");
  assert.equal(entryText({}), "");
  assert.equal(entryText({ type: "message", message: { role: "user", content: undefined } }), "");
});

test("entryText skips thinking/tool blocks and non-message entries", () => {
  assert.equal(
    entryText(
      user([{ type: "thinking", text: "思考" }, { type: "tool", text: "工具" }, { type: "text", text: "正文" }] as Array<{ type: string; text?: string }>),
    ),
    "正文",
  );
  // 跳过 compaction 等非消息 entry（注释见 core/entries.ts）
  assert.equal(entryText({ type: "compaction", message: { role: "user", content: "不应被提取" } }), "");
});

test("isUserMessage requires a message entry with user role", () => {
  assert.equal(isUserMessage(user("x")), true);
  assert.equal(isUserMessage({ type: "message", message: { role: "assistant", content: "x" } }), false);
  assert.equal(isUserMessage({ type: "compaction", message: { role: "user", content: "x" } }), false);
  assert.equal(isUserMessage({}), false);
});
