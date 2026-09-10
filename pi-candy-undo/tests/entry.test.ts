/**
 * pi 入口的集成测试：在不运行 pi 的情况下验证事件接线、ctx 适配器
 * 与命令注册。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathExists } from "../src/storage.ts";
import path from "node:path";
import { test } from "node:test";
import piCandyUndo from "../extensions/index.ts";
import type { BranchEntry } from "../src/types.ts";
import { makeTempDir, removeTempDir, selectContaining, selectStartsWith, writeTextFile } from "./helpers.ts";

interface StubState {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  branch: BranchEntry[];
  leafId: string | null;
  notices: Array<{ message: string; type: string }>;
  selectQueue: Array<(options: string[]) => string | undefined>;
  navigations: string[];
}

function createStub(cwd: string): { pi: unknown; state: StubState; ctx: unknown } {
  const state: StubState = {
    handlers: new Map(),
    commands: new Map(),
    branch: [],
    leafId: null,
    notices: [],
    selectQueue: [],
    navigations: [],
  };
  const sessionManager = {
    getSessionId: () => "entry-session",
    getBranch: () => state.branch,
    getLeafId: () => state.leafId,
    getEntry: (id: string) => state.branch.find((entry) => entry.id === id),
  };
  const ui = {
    notify: (message: string, type: "info" | "warning" | "error") => state.notices.push({ message, type }),
    select: async (_title: string, options: string[]) => {
      const answer = state.selectQueue.shift();
      return answer ? answer(options) : undefined;
    },
    input: async () => undefined,
  };
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager,
    ui,
    navigateTree: async (targetId: string) => {
      state.navigations.push(targetId);
      return { cancelled: false };
    },
    waitForIdle: async () => {},
    isProjectTrusted: () => (state as { trusted?: boolean }).trusted !== false,
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      state.handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      state.commands.set(name, options);
    },
  };
  return { pi, state, ctx };
}

async function fire(state: StubState, ctx: unknown, event: string, payload: unknown = {}): Promise<void> {
  const handler = state.handlers.get(event);
  assert.ok(handler, `handler for ${event}`);
  await handler(payload, ctx);
}

test("entry point wires events, commands and performs an undo round trip", async () => {
  const root = await makeTempDir();
  try {
    const workspace = path.join(root, "workspace");
    const storage = path.join(root, "storage");
    await writeTextFile(path.join(workspace, ".keep"), "");
    await writeTextFile(
      path.join(workspace, ".pi", "settings.json"),
      JSON.stringify({ candyUndo: { storageDir: storage, language: "en" } }),
    );

    const { pi, state, ctx } = createStub(workspace);
    piCandyUndo(pi as never);
    assert.ok(state.commands.has("undo"));
    assert.ok(state.commands.has("redo"));

    await fire(state, ctx, "session_start", { reason: "startup" });
    assert.equal(state.notices.length, 0, "no config warnings");

    // 操作 1
    const file = path.join(workspace, "a.txt");
    await writeTextFile(file, "v0");
    await fire(state, ctx, "input", { text: "first", source: "interactive", streamingBehavior: undefined });
    await fire(state, ctx, "before_agent_start", { prompt: "first" });
    state.branch.push({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } });
    state.leafId = "u1";
    await fire(state, ctx, "tool_call", { toolName: "write", input: { path: "a.txt", content: "v1" } });
    await writeTextFile(file, "v1");
    state.branch.push({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "ok" } });
    state.leafId = "a1";
    await fire(state, ctx, "turn_end", {});
    await fire(state, ctx, "agent_settled", {});

    // 通过注册的命令执行 undo
    state.selectQueue.push(selectContaining("first"));
    state.selectQueue.push(selectStartsWith("Restore code ("));
    await state.commands.get("undo")?.handler("", ctx);
    assert.equal(await readFile(file, "utf8"), "v0");

    // redo 把改动找回来
    await state.commands.get("redo")?.handler("", ctx);
    assert.equal(await readFile(file, "utf8"), "v1");

    await fire(state, ctx, "session_shutdown", {});
  } finally {
    await removeTempDir(root);
  }
});

test("entry point disables itself in non-interactive mode", async () => {
  const root = await makeTempDir();
  try {
    const workspace = path.join(root, "workspace");
    await writeTextFile(path.join(workspace, ".keep"), "");
    await writeTextFile(
      path.join(workspace, ".pi", "settings.json"),
      JSON.stringify({ candyUndo: { storageDir: path.join(root, "storage"), language: "en" } }),
    );
    const { pi, state, ctx } = createStub(workspace);
    (ctx as { hasUI: boolean }).hasUI = false;
    piCandyUndo(pi as never);
    await fire(state, ctx, "session_start", { reason: "startup" });
    await fire(state, ctx, "tool_call", { toolName: "write", input: { path: "a.txt" } });
    await state.commands.get("undo")?.handler("", ctx);
    // 没有 UI 时不跟踪，也不会创建存储目录。
    assert.deepEqual(state.notices, []);
    assert.equal(await pathExists(path.join(root, "storage", "entry-session")), false);
  } finally {
    await removeTempDir(root);
  }
});

test("project settings are ignored for untrusted projects", async () => {
  const root = await makeTempDir();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = path.join(root, "agent");
    const globalStorage = path.join(root, "global-storage");
    const projectStorage = path.join(root, "project-storage");
    await writeTextFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ candyUndo: { storageDir: globalStorage, language: "en" } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const workspace = path.join(root, "workspace");
    await writeTextFile(path.join(workspace, ".keep"), "");
    await writeTextFile(
      path.join(workspace, ".pi", "settings.json"),
      JSON.stringify({ candyUndo: { storageDir: projectStorage } }),
    );

    const { pi, state, ctx } = createStub(workspace);
    (state as { trusted?: boolean }).trusted = false;
    piCandyUndo(pi as never);
    await fire(state, ctx, "session_start", { reason: "startup" });

    assert.equal(await pathExists(path.join(globalStorage, "entry-session")), true);
    assert.equal(await pathExists(projectStorage), false);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await removeTempDir(root);
  }
});
