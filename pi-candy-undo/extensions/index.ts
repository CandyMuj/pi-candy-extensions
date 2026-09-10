/**
 * pi-candy-undo 入口。
 *
 * 把 pi 事件与命令接线到会话运行时；全部逻辑位于 `src/`，因此无需 pi
 * 即可单元测试。
 *
 * 完整设计见 docs/design.md。
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { runRedo, runUndo } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { UndoSession, type CommandApi, type SessionApi } from "../src/session.ts";
import type { BranchEntry } from "../src/types.ts";

function settingsFiles(ctx: ExtensionContext): { globalSettingsFile: string; projectSettingsFile: string } {
  return {
    globalSettingsFile: path.join(getAgentDir(), "settings.json"),
    // 项目本地配置仅在项目被信任时才生效（官方指引）。
    projectSettingsFile: ctx.isProjectTrusted()
      ? path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")
      : "",
  };
}

function createEventApi(ctx: ExtensionContext): SessionApi {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    hasUI: ctx.hasUI,
    mode: ctx.mode,
    getSessionFile: () => ctx.sessionManager.getSessionFile(),
    getBranch: () => ctx.sessionManager.getBranch() as unknown as BranchEntry[],
    getLeafId: () => ctx.sessionManager.getLeafId(),
    getEntry: (id: string) => ctx.sessionManager.getEntry(id) as unknown as BranchEntry | undefined,
    notify: (message, type) => ctx.ui.notify(message, type),
    isProjectTrusted: () => ctx.isProjectTrusted(),
  };
}

function createCommandApi(ctx: ExtensionCommandContext, base: SessionApi): CommandApi {
  return {
    ...base,
    select: (title, options) => ctx.ui.select(title, options),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    navigateTree: (targetId, options) => ctx.navigateTree(targetId, options),
    waitForIdle: () => ctx.waitForIdle(),
  };
}

export default function piCandyUndo(pi: ExtensionAPI) {
  const sessions = new Map<string, UndoSession>();

  async function openSession(
    ctx: ExtensionContext,
    event: { reason: string; previousSessionFile?: string },
  ): Promise<UndoSession> {
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = sessions.get(sessionId);
    if (previous) {
      await previous.onShutdown();
    }

    const parsed = loadConfig(settingsFiles(ctx));
    const session = UndoSession.create({
      api: createEventApi(ctx),
      config: parsed.config,
      configWarnings: parsed.warnings,
    });
    sessions.set(sessionId, session);
    await session.start(event);
    return session;
  }

  function currentSession(ctx: ExtensionContext): UndoSession | undefined {
    return sessions.get(ctx.sessionManager.getSessionId());
  }

  pi.on("session_start", async (event, ctx) => {
    await openSession(ctx, {
      reason: event.reason,
      ...(event.previousSessionFile ? { previousSessionFile: event.previousSessionFile } : {}),
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const session = currentSession(ctx);
    if (!session) {
      return;
    }
    sessions.delete(ctx.sessionManager.getSessionId());
    await session.onShutdown();
  });

  pi.on("input", async (event, ctx) => {
    currentSession(ctx)?.onInput(event.text, event.source, event.streamingBehavior);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await currentSession(ctx)?.onBeforeAgentStart(event.prompt);
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentSession(ctx)?.onTurnEnd();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await currentSession(ctx)?.onAgentSettled();
  });

  pi.on("tool_call", async (event, ctx) => {
    await currentSession(ctx)?.onToolCall(event.toolName, event.input);
  });

  pi.registerCommand("undo", {
    description: "撤销最近的 agent 回合（可回退文件与对话）",
    handler: async (_args, ctx) => {
      const session = currentSession(ctx);
      if (!session) {
        ctx.ui.notify("pi-candy-undo 尚未初始化，请先发送一条消息", "warning");
        return;
      }
      await runUndo(session, createCommandApi(ctx, session.api));
    },
  });

  pi.registerCommand("redo", {
    description: "重做最近一次 /undo",
    handler: async (_args, ctx) => {
      const session = currentSession(ctx);
      if (!session) {
        ctx.ui.notify("pi-candy-undo 尚未初始化，请先发送一条消息", "warning");
        return;
      }
      await runRedo(session, createCommandApi(ctx, session.api));
    },
  });
}
