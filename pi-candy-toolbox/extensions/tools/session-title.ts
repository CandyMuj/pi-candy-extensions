/**
 * session-title — 会话标题生成工具
 *
 * 命令：/candy-title [提示词]
 *   - 无参数：按采样策略生成标题
 *   - 带参数：生成时在 prompt 中追加「用户附加要求」
 *
 * 方案逻辑（详见 docs/session-title.md）：
 *   - 四点采样：首条 user（主题）/ 首条 assistant（任务理解）/ 末条 user（当前方向）/
 *     末条 assistant 尾部（当前进展），各截断 sampleChars 字符，成本与会话长度无关
 *   - 双模式：llm（当前模型静默生成，失败自动回退 local）/ local（零 token 本地截断）
 *   - 设置会话名后 notify 显示「旧标题 → 新标题」；与 win-notify 联动：
 *     其标题中的会话名段会自动跟随（session_info_changed），[pi@id] 定位标识不受影响
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../core/config";

export interface SessionTitleConfig {
  /** 生成模式："llm" 用当前模型（失败回退 local），"local" 零 token 本地截断 */
  mode: "llm" | "local";
  /** 标题字符上限（中文字符） */
  maxLength: number;
  /** 每段消息采样字符数 */
  sampleChars: number;
  /** 首次对话结束自动生成（默认关，手动命令为主） */
  autoFirst: boolean;
}

const LLM_TIMEOUT_MS = 30_000;

/** 生成中 spinner 动画帧（与 win-notify 同款盲文动画） */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── 局部最小类型（pi-ai / pi 结构子集，零额外依赖）──────────
interface EntryLike {
  /** 会话 entry 类型，仅处理 "message"（真实结构为 { type, message } 嵌套） */
  type?: string;
  message?: MessageLike;
}
interface MessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}
/** modelRegistry.complete 返回的 AssistantMessage 结构子集 */
interface ResultLike {
  content?: Array<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}
interface ModelRegistryLike {
  /** 官方完整调用：内部处理认证解析、baseUrl 覆盖、headers/env 合并 */
  complete(model: unknown, context: { systemPrompt?: string; messages: unknown[] }, options?: Record<string, unknown>): Promise<ResultLike>;
}
interface ModelLike {
  provider: string;
}
interface CtxLike {
  sessionManager?: { getEntries(): EntryLike[] };
  modelRegistry?: ModelRegistryLike;
  model?: ModelLike | undefined;
  signal?: AbortSignal | undefined;
}

// ── 采样 ─────────────────────────────────────────────────────────
export interface Samples {
  firstUser: string;
  firstAssistant: string;
  lastUser: string;
  lastAssistant: string;
}

/** 提取消息纯文本（跳过 thinking/tool 等非文本块） */
function entryText(e: EntryLike): string {
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

/** 四点采样：首 user/首 assistant 取头部，末 user 取头部，末 assistant 取尾部（结论在尾） */
export function extractSamples(entries: EntryLike[], sampleChars: number): Samples {
  let firstUser = "", firstAssistant = "", lastUser = "", lastAssistant = "";
  for (const e of entries) {
    if (e.type && e.type !== "message") continue;
    const t = entryText(e);
    if (!t) continue;
    const role = e.message?.role;
    if (role === "user") {
      if (!firstUser) firstUser = t;
      lastUser = t;
    } else if (role === "assistant") {
      if (!firstAssistant) firstAssistant = t;
      lastAssistant = t;
    }
  }
  return {
    firstUser: firstUser.slice(0, sampleChars),
    firstAssistant: firstAssistant.slice(0, sampleChars),
    lastUser: lastUser.slice(0, sampleChars),
    lastAssistant: lastAssistant.slice(-sampleChars),
  };
}

// ── Prompt 组装 ──────────────────────────────────────────────────
/** 组装生成 prompt；extra 为命令追加提示词（可选） */
export function buildPrompt(samples: Samples, maxLength: number, extra?: string): { system: string; user: string } {
  const blocks: string[] = [];
  if (samples.firstUser) blocks.push(`[对话开头] 用户: ${samples.firstUser}`);
  if (samples.firstAssistant) blocks.push(`助手: ${samples.firstAssistant}`);
  if (samples.lastUser && samples.lastUser !== samples.firstUser) blocks.push(`[当前方向] 用户: ${samples.lastUser}`);
  if (samples.lastAssistant && samples.lastAssistant !== samples.firstAssistant) blocks.push(`[最近进展] 助手: ${samples.lastAssistant}`);
  const system =
    `你是一个会话标题生成器。根据提供的对话片段，生成一个不超过 ${maxLength} 字的简短会话标题。` +
    `要求：一行输出，只输出标题本身，不要引号、编号或句末标点，概括对话主题而非罗列细节。` +
    (extra ? `\n用户附加要求：${extra}` : "");
  return { system, user: blocks.join("\n\n") };
}

// ── 标题清洗 ─────────────────────────────────────────────────────
/** 清洗文本：去 @文件 引用、控制字符、折叠空白 */
export function cleanText(raw: string): string {
  return raw
    .replace(/@[\w./~-]+/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 标题后处理：去引号、去句末标点、限长 */
export function cleanupTitle(title: string, maxLength: number): string {
  let t = title.trim();
  t = t.replace(/^["'「『“]+|["'」』”]+$/g, "");
  t = t.replace(/[。.!！?？;；,，:：]+$/, "");
  t = t.replace(/\s+/g, " ");
  if (t.length > maxLength) t = t.slice(0, maxLength);
  return t;
}

// ── 生成 ─────────────────────────────────────────────────────────
/** local 模式：首条可用消息清洗截断，零 token */
export function generateTitleLocal(samples: Samples, maxLength: number): string {
  const base = samples.firstUser || samples.lastUser || samples.firstAssistant || "";
  return cleanupTitle(cleanText(base), maxLength);
}

/** 静默调用当前模型生成标题（不产生会话消息）；走 modelRegistry.complete 官方路径 */
async function generateTitleLlm(ctx: CtxLike, prompt: { system: string; user: string }): Promise<string> {
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  if (!model || !registry) throw new Error("当前无可用模型");
  const result = await withTimeout(
    registry.complete(
      model,
      {
        systemPrompt: prompt.system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
      },
      {
        maxTokens: 20,
        temperature: 0.3,
        signal: ctx.signal,
      },
    ),
    LLM_TIMEOUT_MS,
  );
  if (result.stopReason === "error" || result.stopReason === "aborted" || result.errorMessage) {
    throw new Error(result.errorMessage ?? `模型调用失败: ${result.stopReason}`);
  }
  const text = (result.content ?? [])
    .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("模型返回空内容");
  return text;
}

/** 超时保护 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM 调用超时(>${ms / 1000}s)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 主流程：采样 → 生成（llm→local 回退链） */
export async function generateTitle(
  ctx: CtxLike,
  config: SessionTitleConfig,
  extra?: string,
): Promise<{ title: string; mode: "llm" | "local" }> {
  const samples = extractSamples(ctx.sessionManager?.getEntries() ?? [], config.sampleChars);
  const prompt = buildPrompt(samples, config.maxLength, extra);

  if (config.mode === "llm") {
    try {
      const title = cleanupTitle(await generateTitleLlm(ctx, prompt), config.maxLength);
      if (title) return { title, mode: "llm" };
    } catch (e) {
      // LLM 不可用：记录原因，回退 local
      console.error(`[candy-toolbox] session-title: LLM 生成失败，回退本地模式 — ${(e as Error)?.message ?? e}`);
    }
    return { title: generateTitleLocal(samples, config.maxLength), mode: "local" };
  }
  return { title: generateTitleLocal(samples, config.maxLength), mode: "local" };
}

// ── 工具定义 ─────────────────────────────────────────────────────
const tool: ToolDefinition<SessionTitleConfig> = {
  id: "session-title",
  description: "生成/重新生成会话标题：/candy-title [提示词]",
  defaultConfig: { mode: "llm", maxLength: 20, sampleChars: 200, autoFirst: false },
  register(pi: ExtensionAPI, config: SessionTitleConfig): void {
    pi.registerCommand("candy-title", {
      description: "生成/重新生成会话标题，可追加提示词（如 /candy-title 更简洁）",
      handler: async (args, ctx) => {
        // 生成中反馈：spinner 动画 + footer 状态文字，结束时无论成败都清除
        ctx.ui.setWorkingIndicator({ frames: SPINNER_FRAMES, intervalMs: 100 });
        ctx.ui.setStatus("candy-title", "正在生成会话标题…");
        try {
          const extra = args?.trim() || undefined;
          const oldName = pi.getSessionName();
          const { title, mode } = await generateTitle(ctx, config, extra);
          if (!title) {
            ctx.ui.notify("无法生成标题：会话为空或提取不到内容", "error");
            return;
          }
          pi.setSessionName(title);
          const fallback = config.mode === "llm" && mode === "local" ? "（LLM 不可用，已用本地模式）" : "";
          ctx.ui.notify(
            oldName ? `标题已更新：「${oldName}」→「${title}」${fallback}` : `会话标题已设置：「${title}」${fallback}`,
            "info",
          );
        } finally {
          ctx.ui.setWorkingIndicator();
          ctx.ui.setStatus("candy-title", undefined);
        }
      },
    });

    if (config.autoFirst) {
      let turns = 0;
      pi.on("turn_end", async (_e, ctx) => {
        turns++;
        if (turns !== 1) return; // 只在首次对话后
        if (pi.getSessionName()) return; // 已有标题则跳过
        const { title } = await generateTitle(ctx, config);
        if (title) {
          pi.setSessionName(title);
          ctx.ui.notify(`会话标题已设置：「${title}」`, "info");
        }
      });
    }
  },
};

export default tool;
