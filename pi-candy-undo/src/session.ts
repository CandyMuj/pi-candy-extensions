/**
 * Per-session runtime: owns config, storage paths, state and tracker, and maps
 * pi events to tracking actions (docs/design.md §5).
 *
 * The class only depends on the narrow `SessionApi` interface so it can be
 * unit-tested without pi.
 */

import { mkdir } from "node:fs/promises";
import { createExcludeMatcher, type ExcludeMatcher } from "./exclude.ts";
import { createTranslator, type MessageKey, type Translator } from "./i18n.ts";
import { createLogger } from "./log.ts";
import { isSameOrInside } from "./paths.ts";
import { clearRedo, StateStore } from "./state.ts";
import {
  buildStoragePaths,
  cleanupExpiredSessions,
  migrateSessionData,
  readSessionCwdFromFile,
  readSessionIdFromFile,
  readStateFile,
  writeStateFile,
  type StoragePaths,
} from "./storage.ts";
import { Tracker } from "./tracker.ts";
import type { BranchEntry, Logger, UndoConfig } from "./types.ts";

export interface SessionApi {
  sessionId: string;
  cwd: string;
  hasUI: boolean;
  mode: string;
  getSessionFile(): string | undefined;
  getBranch(): BranchEntry[];
  getLeafId(): string | null;
  getEntry(id: string): BranchEntry | undefined;
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** Project-local settings are only honored for trusted projects. */
  isProjectTrusted(): boolean;
}

/** Extra capabilities available only while running a command. */
export interface CommandApi extends SessionApi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  navigateTree(
    targetId: string,
    options: { summarize: boolean; customInstructions?: string },
  ): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
}

export interface CreateSessionOptions {
  api: SessionApi;
  config: UndoConfig;
  configWarnings?: readonly string[];
  platform?: NodeJS.Platform;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function isSlashCommand(text: string | undefined): boolean {
  return typeof text === "string" && text.trimStart().startsWith("/");
}

export class UndoSession {
  readonly api: SessionApi;
  readonly config: UndoConfig;
  readonly paths: StoragePaths;
  readonly store: StateStore;
  readonly tracker: Tracker;
  readonly matcher: ExcludeMatcher;
  readonly logger: Logger;
  readonly t: Translator;
  readonly platform: NodeJS.Platform;
  readonly sleep: ((ms: number) => Promise<void>) | undefined;

  /** True when the plugin is active for this session. */
  active: boolean;
  /** Human-readable reason when `active` is false. */
  inactiveReason: string | undefined;

  private pendingPrompt: string | undefined;
  private skipNextOperation = false;
  private readonly configWarnings: readonly string[];

  private constructor(options: CreateSessionOptions) {
    this.api = options.api;
    this.config = options.config;
    this.configWarnings = options.configWarnings ?? [];
    this.platform = options.platform ?? process.platform;
    this.sleep = options.sleep;
    this.paths = buildStoragePaths(options.config.storageDir, options.api.sessionId);
    this.logger = createLogger({
      logFile: this.paths.logFile,
      enabled: options.config.log,
      tag: options.api.sessionId.slice(0, 8),
    });
    this.matcher = createExcludeMatcher({
      cwd: options.api.cwd,
      patterns: options.config.exclude,
      useDefaults: options.config.excludeDefaults,
      platform: this.platform,
    });
    this.t = createTranslator(options.config.language);
    this.store = new StateStore({
      stateFile: this.paths.stateFile,
      sessionId: options.api.sessionId,
      onError: (error) => this.logger.log(`state flush failed error=${String(error)}`),
    });
    this.active = false;
    this.inactiveReason = undefined;
    this.tracker = new Tracker({
      cwd: options.api.cwd,
      config: options.config,
      matcher: this.matcher,
      store: this.store,
      paths: this.paths,
      logger: this.logger,
      platform: this.platform,
      now: options.now,
      isHardExcluded: (absolutePath) => isSameOrInside(this.paths.root, absolutePath, this.platform),
      onNotice: (key, params) => this.notifyKey(key, params),
    });
  }

  static create(options: CreateSessionOptions): UndoSession {
    return new UndoSession(options);
  }

  get cwd(): string {
    return this.api.cwd;
  }

  notifyKey(key: MessageKey, params?: Record<string, string | number>, type: "info" | "warning" | "error" = "warning"): void {
    if (!this.api.hasUI) {
      return;
    }
    this.api.notify(this.t(key, params), type);
  }

  /** Load (or migrate) state and prepare the baseline snapshot. */
  async start(event: { reason: string; previousSessionFile?: string }): Promise<void> {
    if (this.configWarnings.length > 0) {
      this.logger.log(`config warnings: ${this.configWarnings.join(" | ")}`);
      this.notifyKey("notify.configWarning", { details: this.configWarnings.join("; ") }, "warning");
    }
    if (!this.config.enabled) {
      this.active = false;
      this.inactiveReason = "disabled";
      return;
    }
    if (isSameOrInside(this.api.cwd, this.paths.root, this.platform)) {
      this.active = false;
      this.inactiveReason = "storage-inside-workspace";
      this.notifyKey("notify.storageError", { error: this.paths.root }, "error");
      return;
    }
    if (!this.api.hasUI) {
      this.active = false;
      this.inactiveReason = "no-ui";
      return;
    }

    try {
      await mkdir(this.paths.backupsDir, { recursive: true });
    } catch (error) {
      this.active = false;
      this.inactiveReason = `storage-error: ${String(error)}`;
      this.notifyKey("notify.storageError", { error: String(error) }, "error");
      return;
    }

    if (event.reason === "fork" && event.previousSessionFile) {
      await this.migrateFrom(event.previousSessionFile);
    }

    const state = (await readStateFile(this.paths.stateFile)) ?? this.store.state;
    this.store.setState(state);
    await this.tracker.ensureBaseline();
    await this.store.flush();
    this.active = true;
    this.logger.log(`session start reason=${event.reason} tracked=${state.trackedFiles.length} snapshots=${state.snapshots.length}`);

    void this.cleanupExpired();
  }

  private async migrateFrom(previousSessionFile: string): Promise<void> {
    const previousSessionId = await readSessionIdFromFile(previousSessionFile);
    if (!previousSessionId || previousSessionId === this.api.sessionId) {
      return;
    }
    const previousCwd = await readSessionCwdFromFile(previousSessionFile);
    if (previousCwd !== undefined && !isSameOrInside(previousCwd, this.api.cwd, this.platform)) {
      // Relative stored paths only make sense for the same working directory.
      this.logger.log(`skip migration: cwd changed from ${previousCwd} to ${this.api.cwd}`);
      return;
    }
    const previousDir = buildStoragePaths(this.config.storageDir, previousSessionId).sessionDir;
    const result = await migrateSessionData(previousDir, this.paths, this.api.sessionId);
    if (result.migrated) {
      this.logger.log(
        `migrated from=${previousSessionId} linked=${result.linked} copied=${result.copied} state=${result.stateCopied}`,
      );
      this.notifyKey("notify.migrated", { count: result.linked + result.copied }, "info");
    }
  }

  private cleanupExpired(): void {
    const days = this.config.cleanupPeriodDays;
    if (days <= 0) {
      return;
    }
    void cleanupExpiredSessions(this.paths.root, days * 24 * 60 * 60 * 1000, this.api.sessionId)
      .then((result) => {
        if (result.removed.length > 0 || result.errors.length > 0) {
          this.logger.log(
            `cleanup removed=${result.removed.join(",")} errors=${result.errors.join("|")}`,
          );
        }
      })
      .catch(() => {});
  }

  onInput(text: string, source: string, streamingBehavior: string | undefined): void {
    if (!this.active || streamingBehavior !== undefined) {
      return;
    }
    if (source === "extension") {
      // Extension-injected messages must not start a new undo operation.
      this.pendingPrompt = undefined;
      this.skipNextOperation = true;
      return;
    }
    if (isSlashCommand(text)) {
      this.pendingPrompt = undefined;
      return;
    }
    this.pendingPrompt = text;
    // A new real prompt invalidates the redo stack (docs §6).
    if (this.store.state.redo.length > 0) {
      clearRedo(this.store.state);
      this.store.markDirty();
    }
  }

  async onBeforeAgentStart(prompt: string): Promise<void> {
    if (!this.active) {
      return;
    }
    if (this.skipNextOperation) {
      this.skipNextOperation = false;
      return;
    }
    if (isSlashCommand(prompt) || isSlashCommand(this.pendingPrompt)) {
      return;
    }
    if (this.tracker.hasPendingOperation()) {
      return;
    }
    await this.tracker.beginOperation(this.api.getLeafId());
  }

  onTurnEnd(): void {
    if (!this.active) {
      return;
    }
    this.tracker.bindOperation(this.api.getBranch());
  }

  async onAgentSettled(): Promise<void> {
    if (!this.active) {
      return;
    }
    this.tracker.bindOperation(this.api.getBranch());
    this.tracker.finishOperation();
    await this.store.flush();
  }

  async onToolCall(toolName: string, input: unknown): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      await this.tracker.trackToolCall(toolName, input);
    } catch (error) {
      // Never block a tool because of undo bookkeeping (docs: tool_call is fail-safe).
      this.logger.log(`track failed tool=${toolName} error=${String(error)}`);
    }
  }

  async onShutdown(): Promise<void> {
    await this.store.dispose();
  }

  /** Remove every redo entry (used when the stack is invalidated). */
  clearRedoStack(): void {
    if (this.store.state.redo.length === 0) {
      return;
    }
    clearRedo(this.store.state);
    this.store.markDirty();
  }

  /** Persist state after a mutation made outside the tracker. */
  async persist(): Promise<void> {
    await writeStateFile(this.paths.stateFile, this.store.state);
  }
}
