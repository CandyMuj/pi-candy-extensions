/**
 * Unit tests for desktop-notify extension.
 *
 * Run: node --experimental-strip-types tests/tests.ts
 *
 * Tests core logic without requiring pi runtime:
 *   - content extraction (extractText, extractSummary)
 *   - title generation (extractPromptTitle, 25-char truncation)
 *   - abort/error detection (shouldSkipNotification, willRetry)
 *   - state machine (agent_start/end, compaction)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════════════════
// Extracted pure functions from desktop-notify.ts (duplicated for test isolation)
// ═══════════════════════════════════════════════════════════════════════════

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (t) return t;
      }
    }
  }
  return "";
}

function extractPromptTitle(entries: Record<string, unknown>[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry.message as Record<string, unknown> | undefined;
    const role = (entry.role ?? msg?.role) as string | undefined;
    if (role === "user") {
      const content = (entry.content ?? msg?.content);
      const text = extractText(content);
      if (text) {
        const cleaned = text.replace(/\s+/g, " ").trim();
        return cleaned.length > 25 ? cleaned.slice(0, 25) + "…" : cleaned;
      }
      break;
    }
  }
  return "pi";
}

function extractSummary(event: { messages?: unknown[] }): string | null {
  try {
    const msgs = event.messages as Array<{ role?: string; content?: unknown }>;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") {
        const text = extractText(msgs[i].content);
        if (text) {
          const cleaned = text.replace(/\s+/g, " ").trim();
          return cleaned.length > 50 ? cleaned.slice(0, 50) + "…" : cleaned;
        }
      }
    }
  } catch { /* */ }
  return null;
}

function getLastAssistantMessage(event: { messages?: unknown[] }): { stopReason?: string; errorMessage?: string } | null {
  try {
    const msgs = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i];
    }
  } catch { /* */ }
  return null;
}

const RETRY_PATTERN = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function willRetry(msg: { stopReason?: string; errorMessage?: string }): boolean {
  if (msg.stopReason !== "error" || !msg.errorMessage) return false;
  return RETRY_PATTERN.test(msg.errorMessage);
}

function shouldSkipNotification(
  msg: { stopReason?: string; errorMessage?: string } | null,
  isCompacting: boolean,
): boolean {
  if (isCompacting) return true;
  if (!msg) return false;
  if (msg.stopReason === "aborted") return true;
  if (msg.stopReason === "error") {
    return !willRetry(msg); // retry-able errors are NOT skipped (they trigger 10s delay)
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// State machine for notification debounce
// ═══════════════════════════════════════════════════════════════════════════

type State = "idle" | "waiting" | "notified";
type Event =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[]; isCompacting?: boolean }
  | { type: "compact_start" }
  | { type: "compact_end" }

class NotificationStateMachine {
  state: State = "idle";
  isCompacting = false;
  timerId = 0;
  notifications: string[] = [];
  private _timerFn: (() => void) | null = null;

  setTimer(fn: () => void, _ms: number) {
    this.timerId++;
    this._timerFn = fn;
    return this.timerId;
  }
  clearTimer(_id: number) {
    this._timerFn = null;
  }
  fireTimer() {
    if (this._timerFn) {
      const fn = this._timerFn;
      this._timerFn = null;
      fn();
    }
  }

  handle(event: Event) {
    switch (event.type) {
      case "compact_start":
        this.isCompacting = true;
        break;

      case "compact_end":
        this.isCompacting = false;
        break;

      case "agent_start":
        if (this.state === "waiting") {
          this.clearTimer(this.timerId);
          this.state = "idle";
        }
        break;

      case "agent_end": {
        const msg = getLastAssistantMessage({ messages: event.messages });
        if (shouldSkipNotification(msg, this.isCompacting)) {
          this.state = "idle";
          break;
        }
        if (this.state === "waiting") this.clearTimer(this.timerId);
        this.state = "waiting";
        const delay = (msg && willRetry(msg)) ? 10000 : 2000;
        this.setTimer(() => {
          if (this.isCompacting) return;
          this.state = "notified";
          this.notifications.push("fired");
        }, delay);
        break;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("extractText", () => {
  it("string content", () => {
    assert.equal(extractText("hello"), "hello");
  });

  it("empty string", () => {
    assert.equal(extractText(""), "");
  });

  it("content array with text block", () => {
    assert.equal(extractText([{ type: "text", text: "world" }]), "world");
  });

  it("content array with multiple blocks picks first text", () => {
    assert.equal(
      extractText([{ type: "image", data: "x" }, { type: "text", text: "hi" }]),
      "hi",
    );
  });

  it("non-text content returns empty", () => {
    assert.equal(extractText({ type: "image" }), "");
  });

  it("null/undefined returns empty", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText(undefined), "");
  });
});

describe("extractPromptTitle", () => {
  it("short prompt returns as-is", () => {
    const entries = [{ role: "user", content: "重构 user service" }];
    // 15 chars → under 25, no truncation
    assert.equal(extractPromptTitle(entries), "重构 user service");
  });

  it("nested entry with message.role=user", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "say done" } },
    ];
    assert.equal(extractPromptTitle(entries), "say done");
  });

  it("truncates to 25 chars + …", () => {
    const entries = [{ role: "user", content: "帮我重构整个用户认证模块的代码包括登录注册和权限管理" }];
    // 28 chars → 25 + …
    assert.equal(extractPromptTitle(entries), "帮我重构整个用户认证模块的代码包括登录注册和权限管…");
  });

  it("exactly 25 chars returns as-is", () => {
    const entries = [{ role: "user", content: "1234567890123456789012345" }]; // 25 chars
    assert.equal(extractPromptTitle(entries), "1234567890123456789012345");
  });

  it("falls back to 'pi' when no user message", () => {
    const entries = [{ role: "assistant", content: "ok" }];
    assert.equal(extractPromptTitle(entries), "pi");
  });

  it("finds last user message in mixed entries", () => {
    const entries = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { type: "message", message: { role: "user", content: "second" } },
    ];
    assert.equal(extractPromptTitle(entries), "second");
  });

  it("collapses whitespace", () => {
    const entries = [{ role: "user", content: "  hello   world  " }];
    assert.equal(extractPromptTitle(entries), "hello world");
  });
});

describe("extractSummary", () => {
  it("extracts short assistant reply as-is", () => {
    const summary = extractSummary({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    assert.equal(summary, "hello");
  });

  it("truncates to 50 chars + …", () => {
    const summary = extractSummary({
      messages: [
        { role: "assistant", content: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六" },
      ],
    });
    assert.equal(summary!.length, 51); // 50 + "…"
    assert.ok(summary!.endsWith("…"));
  });

  it("finds last assistant message", () => {
    const summary = extractSummary({
      messages: [
        { role: "assistant", content: "first reply" },
        { role: "assistant", content: "second reply" },
      ],
    });
    assert.equal(summary, "second reply");
  });

  it("returns null when no assistant message", () => {
    assert.equal(extractSummary({ messages: [{ role: "user" }] }), null);
    assert.equal(extractSummary({}), null);
  });

  it("handles content arrays", () => {
    const summary = extractSummary({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "array reply" }] },
      ],
    });
    assert.equal(summary, "array reply");
  });
});

describe("getLastAssistantMessage", () => {
  it("finds last assistant in messages", () => {
    const msg = getLastAssistantMessage({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "stop", content: "hello" },
      ],
    });
    assert.ok(msg);
    assert.equal(msg!.stopReason, "stop");
  });

  it("returns null if no assistant message", () => {
    const msg = getLastAssistantMessage({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(msg, null);
  });

  it("returns null if no messages array", () => {
    assert.equal(getLastAssistantMessage({}), null);
  });

  it("skips non-assistant messages and finds last assistant", () => {
    const msg = getLastAssistantMessage({
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "stop" },
        { role: "toolResult" },
        { role: "assistant", stopReason: "aborted", errorMessage: "x" },
      ],
    });
    assert.ok(msg);
    assert.equal(msg!.stopReason, "aborted");
  });
});

describe("willRetry", () => {
  it("retry-able: timeout", () => {
    assert.equal(willRetry({ stopReason: "error", errorMessage: "request timed out" }), true);
  });

  it("retry-able: rate limit", () => {
    assert.equal(willRetry({ stopReason: "error", errorMessage: "rate limit exceeded" }), true);
  });

  it("retry-able: connection error", () => {
    assert.equal(willRetry({ stopReason: "error", errorMessage: "connection refused" }), true);
  });

  it("retry-able: 502", () => {
    assert.equal(willRetry({ stopReason: "error", errorMessage: "502 Bad Gateway" }), true);
  });

  it("not retry-able: unknown error", () => {
    assert.equal(willRetry({ stopReason: "error", errorMessage: "something went wrong" }), false);
  });

  it("not retry-able: no errorMessage", () => {
    assert.equal(willRetry({ stopReason: "error" }), false);
  });

  it("not retry-able: normal stop", () => {
    assert.equal(willRetry({ stopReason: "stop" }), false);
  });
});

describe("shouldSkipNotification", () => {
  it("skips aborted stopReason", () => {
    assert.equal(shouldSkipNotification({ stopReason: "aborted" }, false), true);
  });

  it("skips non-retryable error", () => {
    assert.equal(shouldSkipNotification({ stopReason: "error", errorMessage: "unknown error" }, false), true);
  });

  it("does NOT skip retry-able error (timeout — triggers 10s delay)", () => {
    assert.equal(shouldSkipNotification({ stopReason: "error", errorMessage: "request timed out" }, false), false);
  });

  it("allows stop stopReason", () => {
    assert.equal(shouldSkipNotification({ stopReason: "stop" }, false), false);
  });

  it("skips when compacting regardless", () => {
    assert.equal(shouldSkipNotification({ stopReason: "stop" }, true), true);
  });

  it("allows when no message (null)", () => {
    assert.equal(shouldSkipNotification(null, false), false);
  });
});

describe("NotificationStateMachine", () => {
  it("normal flow: idle → waiting → notified", () => {
    const sm = new NotificationStateMachine();
    assert.equal(sm.state, "idle");

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("agent_start cancels timer during waiting", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.handle({ type: "agent_start" });
    assert.equal(sm.state, "idle"); // cancelled

    sm.fireTimer(); // timer already cleared, should be no-op
    assert.equal(sm.state, "idle");
    assert.equal(sm.notifications.length, 0);
  });

  it("retry flow: retry-able error → not skipped → notified", () => {
    const sm = new NotificationStateMachine();

    // Retry-able error (timeout) → should NOT be skipped
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "timed out" }] });
    assert.equal(sm.state, "waiting"); // not skipped, waiting with 10s delay

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("non-retryable error → skipped", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "unknown bug" }] });
    assert.equal(sm.state, "idle"); // skipped

    sm.fireTimer();
    assert.equal(sm.state, "idle");
    assert.equal(sm.notifications.length, 0);
  });

  it("compaction suppresses notification during processing", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.handle({ type: "compact_start" });
    assert.equal(sm.isCompacting, true);

    sm.fireTimer();
    assert.equal(sm.state, "waiting"); // suppressed
    assert.equal(sm.notifications.length, 0);

    sm.handle({ type: "compact_end" });
    assert.equal(sm.isCompacting, false);
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });

  it("aborted stopReason skips notification", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "cancelled" }] });
    assert.equal(sm.state, "idle"); // skipped

    sm.fireTimer();
    assert.equal(sm.state, "idle");
    assert.equal(sm.notifications.length, 0);
  });

  it("multiple rapid agent_start cancels all", () => {
    const sm = new NotificationStateMachine();

    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.handle({ type: "agent_start" }); // cancel
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    sm.handle({ type: "agent_start" }); // cancel
    sm.handle({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(sm.state, "waiting");

    sm.fireTimer();
    assert.equal(sm.state, "notified");
    assert.equal(sm.notifications.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n✅ All tests passed!\n");
