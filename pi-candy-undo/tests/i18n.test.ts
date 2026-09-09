import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, MESSAGES, messageKeys } from "../src/i18n.ts";

test("every message has non-empty zh and en text", () => {
  for (const key of messageKeys()) {
    const entry = MESSAGES[key];
    assert.equal(typeof entry.zh, "string", `${key} zh`);
    assert.equal(typeof entry.en, "string", `${key} en`);
    assert.ok(entry.zh.trim().length > 0, `${key} zh is empty`);
    assert.ok(entry.en.trim().length > 0, `${key} en is empty`);
  }
});

test("translator picks the requested language", () => {
  assert.equal(createTranslator("zh")("notify.nothingToUndo"), "没有可回退的消息");
  assert.equal(createTranslator("en")("notify.nothingToUndo"), "Nothing to undo");
});

test("translator substitutes parameters", () => {
  const t = createTranslator("en");
  assert.equal(t("picker.filesChanged", { files: 3 }), "3 file(s)");
  assert.equal(t("picker.lines", { insertions: 12, deletions: 4 }), "+12 -4");
  assert.equal(t("notify.oversize", { mb: 100, path: "a.txt" }), "File exceeds 100MB and is not tracked for undo: a.txt");
});

test("unknown placeholders are left untouched", () => {
  assert.equal(createTranslator("en")("picker.filesChanged"), "{files} file(s)");
});
