/**
 * tools/session-title.ts：四点采样 / prompt 组装 / 文本清洗 / 生成主流程与命令
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTitleConfig } from "../extensions/tools/session-title.ts";
import { makeCtx, makeLogger, makePiStub, useTempAgentDir } from "./helpers.ts";

useTempAgentDir();
const {
  default: sessionTitle,
  buildPrompt,
  cleanText,
  cleanupTitle,
  extractSamples,
  generateTitle,
  generateTitleLocal,
} = await import("../extensions/tools/session-title.ts");

const CONFIG: SessionTitleConfig = { mode: "llm", maxLength: 20, sampleChars: 200, autoFirst: false };
const EMPTY_SAMPLES = { firstUser: "", firstAssistant: "", lastUser: "", lastAssistant: "" };

/** extractSamples 的参数类型（session-title 未导出 EntryLike，用它反推） */
type TestEntry = Parameters<typeof extractSamples>[0][number];

/** 构造测试用 entry；非 message 的字段（name/customType 等）靠断言带过 */
function entry(value: Record<string, unknown>): TestEntry {
  return value as TestEntry;
}

function userEntry(text: string): TestEntry {
  return entry({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantEntry(text: string): TestEntry {
  return entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
}

/** 假 modelRegistry：记录每次模型调用，可配置返回值或抛错 */
function makeRegistry(reply: string | Error, options: { modelFound?: boolean } = {}) {
  const calls: Array<{ model: string; system: string; user: string; maxTokens?: number }> = [];
  const registry = {
    find: () =>
      options.modelFound === false ? undefined : { provider: "test-provider", id: "test-model" },
    complete: async (model: { provider: string; id: string }, context: any, opts: any) => {
      calls.push({
        model: `${model.provider}/${model.id}`,
        system: context.systemPrompt ?? "",
        user: context.messages?.[0]?.content?.[0]?.text ?? "",
        maxTokens: opts?.maxTokens,
      });
      if (reply instanceof Error) throw reply;
      return { stopReason: "stop", content: reply === "" ? [] : [{ type: "text", text: reply }] };
    },
  };
  return { registry, calls };
}

const MODEL = { provider: "test-provider", id: "test-model" };

/* ── 采样 ───────────────────────────────────────────────────────── */

test("extractSamples picks first/last user and assistant messages", () => {
  const samples = extractSamples(
    [
      entry({ type: "session" }),
      userEntry("首条 user"),
      assistantEntry("首条 assistant"),
      entry({ type: "session_info", name: "旧标题" }),
      userEntry("末条 user"),
      assistantEntry("末条 assistant"),
    ],
    200,
  );
  assert.deepEqual(samples, {
    firstUser: "首条 user",
    firstAssistant: "首条 assistant",
    lastUser: "末条 user",
    lastAssistant: "末条 assistant",
  });
});

test("extractSamples truncates from the head, except the last assistant (tail)", () => {
  const samples = extractSamples([userEntry("0123456789"), assistantEntry("0123456789")], 4);
  assert.equal(samples.firstUser, "0123");
  assert.equal(samples.lastUser, "0123");
  assert.equal(samples.firstAssistant, "0123");
  assert.equal(samples.lastAssistant, "6789");
});

test("extractSamples skips non-message entries and non-text blocks", () => {
  const samples = extractSamples(
    [
      entry({ type: "compaction", summary: "x" }),
      entry({ type: "custom", customType: "plan-mode-state" }),
      entry({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "内心戏" }] } }),
      entry({ type: "message", message: { role: "toolResult", content: "工具输出" } }),
      userEntry("真正的用户消息"),
    ],
    200,
  );
  assert.equal(samples.firstUser, "真正的用户消息");
  assert.equal(samples.firstAssistant, "");
});

test("extractSamples on an empty session yields empty samples", () => {
  assert.deepEqual(extractSamples([entry({ type: "session" }), entry({ type: "model_change" })], 200), EMPTY_SAMPLES);
});

/* ── prompt 组装 ───────────────────────────────────────────────── */

test("buildPrompt carries the four blocks and the extra requirement", () => {
  const { system, user } = buildPrompt(
    { firstUser: "U1", firstAssistant: "A1", lastUser: "U2", lastAssistant: "A2" },
    20,
    "用英文",
  );
  assert.match(system, /不超过 20 字/);
  assert.match(system, /用户附加要求：用英文/);
  assert.match(user, /\[对话开头\] 用户: U1/);
  assert.match(user, /\[当前方向\] 用户: U2/);
  assert.match(user, /\[最近进展\] 助手: A2/);
});

test("buildPrompt omits duplicated blocks and the extra line when absent", () => {
  const { system, user } = buildPrompt({ ...EMPTY_SAMPLES, firstUser: "same", lastUser: "same" }, 20);
  assert.equal(user, "[对话开头] 用户: same");
  assert.doesNotMatch(system, /用户附加要求/);
});

/* ── 文本清洗 ───────────────────────────────────────────────────── */

test("cleanText strips @file references, control chars and collapses whitespace", () => {
  assert.equal(cleanText(" 看下 @src/a.ts 里的\u0007 问题 "), "看下 里的 问题");
  // 控制字符（含换行）直接删除而非折成空格：现有行为，换行两侧文本会相连
  assert.equal(cleanText("a\n\nb"), "ab");
});

test("cleanupTitle strips quotes and trailing punctuation, enforces maxLength", () => {
  assert.equal(cleanupTitle("「会话标题。」", 20), "会话标题");
  assert.equal(cleanupTitle('  "带引号"  ', 20), "带引号");
  assert.equal(cleanupTitle("a".repeat(40), 10), "a".repeat(10));
});

test("generateTitleLocal falls back to the first available text", () => {
  assert.equal(generateTitleLocal({ ...EMPTY_SAMPLES, firstUser: "帮我看看 config 解析" }, 20), "帮我看看 config 解析");
  assert.equal(generateTitleLocal({ ...EMPTY_SAMPLES, firstAssistant: "只有助手消息" }, 20), "只有助手消息");
  assert.equal(generateTitleLocal(EMPTY_SAMPLES, 20), "");
});

/* ── 生成主流程 ─────────────────────────────────────────────────── */

test("empty session short-circuits: no model call, empty title", async () => {
  const { registry, calls } = makeRegistry("不会用到");
  const { ctx } = makeCtx({ entries: [{ type: "session" }, { type: "model_change" }], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, CONFIG);
  assert.deepEqual(result, { title: "", mode: "local" });
  assert.equal(calls.length, 0);
});

test("empty session with a hint argument still does not call the model", async () => {
  const { registry, calls } = makeRegistry("不会用到");
  const { ctx } = makeCtx({ entries: [], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, CONFIG, "小米SU7 Ultra 开售与定价讨论");
  assert.deepEqual(result, { title: "", mode: "local" });
  assert.equal(calls.length, 0);
});

test("llm mode returns the cleaned model title and sends the samples", async () => {
  const { registry, calls } = makeRegistry("「会话标题。」");
  const { ctx } = makeCtx({ entries: [userEntry("帮我看看 config 解析")], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, CONFIG);
  assert.deepEqual(result, { title: "会话标题", mode: "llm" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, "test-provider/test-model");
  assert.match(calls[0]?.user ?? "", /帮我看看 config 解析/);
  assert.equal(calls[0]?.maxTokens, CONFIG.maxLength * 2 + 20);
});

test("model returning empty text falls back to local and notifies", async () => {
  const { registry } = makeRegistry("");
  const { ctx, notices } = makeCtx({ entries: [userEntry("回退到本地标题")], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, CONFIG);
  assert.deepEqual(result, { title: "回退到本地标题", mode: "local" });
  const text = notices.map((notice) => notice.message).join("\n");
  assert.match(text, /模型返回空内容/);
  assert.match(text, /LLM 生成失败，回退本地模式/);
});

test("model failure falls back to local and notifies the reason", async () => {
  const { registry } = makeRegistry(new Error("401 invalid api key"));
  const { ctx, notices } = makeCtx({ entries: [userEntry("失败也要有标题")], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, CONFIG);
  assert.deepEqual(result, { title: "失败也要有标题", mode: "local" });
  const text = notices.map((notice) => notice.message).join("\n");
  assert.match(text, /模型 test-provider\/test-model 调用失败/);
  assert.match(text, /LLM 生成失败，回退本地模式/);
});

test("configured model that cannot be resolved notifies and falls back to the session model", async () => {
  const { registry, calls } = makeRegistry("标题", { modelFound: false });
  const { ctx, notices } = makeCtx({ entries: [userEntry("配置的模型不存在")], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, { ...CONFIG, model: "openrouter/foo" });
  assert.deepEqual(result, { title: "标题", mode: "llm" });
  assert.match(notices[0]?.message ?? "", /配置的模型 openrouter\/foo 未找到/);
  assert.equal(calls.length, 1);
});

test("local mode never calls the model", async () => {
  const { registry, calls } = makeRegistry("不会用到");
  const { ctx } = makeCtx({ entries: [userEntry("本地模式标题")], modelRegistry: registry, model: MODEL });

  const result = await generateTitle(ctx, { ...CONFIG, mode: "local" });
  assert.deepEqual(result, { title: "本地模式标题", mode: "local" });
  assert.equal(calls.length, 0);
});

/* ── 命令 ─────────────────────────────────────────────────────── */

function registerCommand(entries: unknown[], reply = "模型给的标题") {
  const { registry, calls } = makeRegistry(reply);
  const stub = makePiStub();
  sessionTitle.register(stub.pi, { ...CONFIG }, makeLogger().log);
  const ui = makeCtx({ entries, modelRegistry: registry, model: MODEL });
  return { stub, calls, ui, command: stub.commands.get("candy-title") };
}

test("/candy-title on an empty session reports it and does not rename", async () => {
  const { stub, ui, command, calls } = registerCommand([]);
  await command?.handler("", ui.ctx);

  assert.equal(stub.setNames.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(ui.notices, [{ message: "无法生成标题：会话为空或提取不到内容", type: "error" }]);
});

test("/candy-title sets the session name and reports old → new", async () => {
  const { stub, ui, command } = registerCommand([userEntry("生成标题用的消息")]);
  stub.pi.setSessionName("旧标题");
  stub.setNames.length = 0;

  await command?.handler("", ui.ctx);

  assert.deepEqual(stub.setNames, ["模型给的标题"]);
  assert.match(ui.notices[0]?.message ?? "", /标题已更新：「旧标题」→「模型给的标题」/);
  assert.equal(ui.statuses.get("candy-title"), undefined, "生成结束应清掉 footer 状态");
});

test("/candy-title config prints the effective config", async () => {
  const { ui, command } = registerCommand([]);
  await command?.handler("config", ui.ctx);
  assert.match(ui.notices[0]?.message ?? "", /^mode=llm maxLength=20 sampleChars=200 autoFirst=false model=当前会话模型$/);
});

test("argument completions cover config and its subcommands", () => {
  const { command } = registerCommand([]);
  assert.deepEqual(command?.getArgumentCompletions?.(""), [{ value: "config", label: "查看/修改配置" }]);

  const subValues = (command?.getArgumentCompletions?.("config ") ?? []).map((item: { value: string }) => item.value);
  assert.deepEqual(subValues, [
    "config mode",
    "config maxLength",
    "config sampleChars",
    "config autoFirst",
    "config model",
  ]);

  const modeValues = (command?.getArgumentCompletions?.("config mode ") ?? []).map((item: { value: string }) => item.value);
  assert.deepEqual(modeValues, ["config mode llm", "config mode local"]);

  assert.equal(command?.getArgumentCompletions?.("随手写的提示词"), null);
});
