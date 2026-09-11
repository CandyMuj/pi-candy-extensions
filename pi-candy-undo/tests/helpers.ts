/**
 * 测试辅助：临时目录、假的 pi 会话 API 与假的 branch 条目。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { CommandApi } from "../src/session.ts";
import type { BranchEntry, UndoConfig } from "../src/types.ts";

export function makeConfig(overrides: Partial<UndoConfig> = {}): UndoConfig {
  return { ...DEFAULT_CONFIG, language: "en", ...overrides };
}

export async function makeTempDir(prefix = "pi-candy-undo-"): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeTextFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

export type SelectAnswer = (options: string[]) => string | undefined;

/** 选取第一个包含给定子串的选项。 */
export function selectContaining(substring: string): SelectAnswer {
  return (options) => options.find((option) => option.includes(substring));
}

/** 选取第一个以给定前缀开头的选项（菜单文案可能共享词语）。 */
export function selectStartsWith(prefix: string): SelectAnswer {
  return (options) => options.find((option) => option.startsWith(prefix));
}

export function selectCancel(): SelectAnswer {
  return () => undefined;
}

export interface FakeApiOptions {
  cwd: string;
  sessionId?: string;
  hasUI?: boolean;
}

export class FakeSession {
  readonly cwd: string;
  readonly sessionId: string;
  readonly hasUI: boolean;
  branch: BranchEntry[] = [];
  leafId: string | null = null;
  notices: Array<{ message: string; type: string }> = [];
  navigations: Array<{ targetId: string; options: { summarize: boolean; customInstructions?: string } }> = [];
  navigateCancelled = false;
  selectCalls: string[][] = [];
  inputCalls: string[] = [];

  private selectQueue: SelectAnswer[] = [];
  private inputQueue: Array<string | undefined> = [];

  constructor(options: FakeApiOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.sessionId ?? "test-session";
    this.hasUI = options.hasUI ?? true;
  }

  queueSelect(answer: SelectAnswer): void {
    this.selectQueue.push(answer);
  }

  queueInput(answer: string | undefined): void {
    this.inputQueue.push(answer);
  }

  pushUserMessage(id: string, text: string, parentId: string | null = this.leafId): BranchEntry {
    const entry: BranchEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: text },
    };
    this.branch.push(entry);
    this.leafId = id;
    return entry;
  }

  pushAssistant(id: string, parentId: string | null = this.leafId): BranchEntry {
    const entry: BranchEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "ok" },
    };
    this.branch.push(entry);
    this.leafId = id;
    return entry;
  }

  get api(): CommandApi {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      hasUI: this.hasUI,
      getBranch: () => this.branch,
      getLeafId: () => this.leafId,
      getEntry: (id: string) => this.branch.find((entry) => entry.id === id),
      notify: (message, type) => this.notices.push({ message, type }),
      select: async (title, options) => {
        this.selectCalls.push([title, ...options]);
        const answer = this.selectQueue.shift();
        return answer ? answer(options) : undefined;
      },
      input: async (title) => {
        this.inputCalls.push(title);
        return this.inputQueue.shift();
      },
      navigateTree: async (targetId, options) => {
        this.navigations.push({ targetId, options });
        if (this.navigateCancelled) {
          return { cancelled: true };
        }
        this.leafId = targetId;
        return { cancelled: false };
      },
      waitForIdle: async () => {},
    };
  }

  lastNotice(): { message: string; type: string } | undefined {
    return this.notices[this.notices.length - 1];
  }
}
