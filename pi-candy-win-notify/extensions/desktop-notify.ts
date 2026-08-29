/**
 * Pi Desktop Notification — 桌面通知扩展
 *
 * pi 完成输出时右下角弹出 WPF 暗色通知窗口。切到其他程序时不会错过。
 *
 * ## 使用
 *
 *   /notify          切换通知开关 (on/off)
 *   /notify on|off   直接设置
 *   弹窗按钮:         知道了  /  继续（切回终端并聚焦）
 *   全局快捷键:       Alt+[ = 知道了    Alt+] = 继续
 *
 * ## 行为
 *
 *   - 右下角置顶、不抢焦点、80% 半透明、15 秒自动消失
 *   - 通知标题 = 当前轮用户消息前 10 字
 *   - LLM 超时重试时自动抑制（2 秒冷却期，只在主动权交还用户时弹）
 *   - 多 pi 窗口安全（各自独立的句柄缓存）
 *   - Footer 状态指示: 🔔 开启 / 🔕 关闭
 * ## 文件
 *
 *   本文件放在 ~/.pi/agent/extensions/ 下自动生效。
 *   调试日志: %TEMP%/pi-notify-debug.log
 *
 * ## 跨平台
 *
 *   Windows:  WPF 暗色窗口 (本扩展主要针对)
 *   macOS:    osascript Notification Center
 *   Linux:    notify-send
 */

import koffi from "koffi";
import { spawn, type ChildProcess } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Win32 API via koffi（零 temp 文件，零 PowerShell）─────────────────
let GetForegroundWindow: () => number;
let GetWindowTextW: (hwnd: number, buf: unknown, maxCount: number) => number;
let GetWindowTextLengthW: (hwnd: number) => number;

function initWin32(): void {
  if (platform() !== "win32") return;
  try {
    const user32 = koffi.load("user32.dll");
    GetForegroundWindow = user32.func("intptr_t GetForegroundWindow()");
    GetWindowTextW = user32.func("int GetWindowTextW(intptr_t hWnd, char16_t* lpString, int nMaxCount)");
    GetWindowTextLengthW = user32.func("int GetWindowTextLengthW(intptr_t hWnd)");
    log("koffi: Win32 API initialized");
  } catch (e: unknown) {
    log(`koffi: init failed — ${e}`);
  }
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
let enabled = true;
let uniqueWindowId = "";
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let taskStartTime = 0;
let psHost: ChildProcess | null = null;
let psHostReady = false;
let psHostCrashCount = 0;
let psHostLastError = "";
let piApi: ExtensionAPI | null = null;

// ── 可配置项 ────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(getAgentDir(), "notify.json");
type Config = { timeout: number; opacity: number; messageMode: "fixed" | "response"; lang: "zh" | "en" | "ja" | "ko"; muteUntil?: number };

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { timeout: saved.timeout ?? 15, opacity: saved.opacity ?? 1.0, messageMode: saved.messageMode ?? "response", lang: saved.lang ?? "en", muteUntil: saved.muteUntil };
    }
  } catch { /* */ }
  return { timeout: 15, opacity: 1.0, messageMode: "response", lang: "en" };
}

function saveConfig(c: Config): void {
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8");
  } catch { /* */ }
}

function saveMuteUntil(ts: number | undefined): void {
  config.muteUntil = ts;
  saveConfig(config);
}

const config = loadConfig();

// ── i18n ────────────────────────────────────────────────────────────────────
const i18n: Record<string, Record<string, string>> = {
  zh: { dismissBtn: " 知 道 了 ", continueBtn: " 继 续 ", completion: "任务完成", switchBack: "可以切回来了", enabled: "通知已开启 🔔", disabled: "通知已关闭 🔕", configTitle: "通知配置", timeoutLabel: "超时", opacityLabel: "不透明度", modeLabel: "模式", langLabel: "语言", statusLabel: "状态", on: "开", off: "关", mute3: "3 分钟", mute30: "30 分钟", mute60: "1 小时", muteOff: "关闭勿扰", muteRemaining: "勿扰剩余{0}分" },
  en: { dismissBtn: " Dismiss ", continueBtn: "Continue", completion: "Task complete", switchBack: "Switch back", enabled: "Notify ON 🔔", disabled: "Notify OFF 🔕", configTitle: "Notify Config", timeoutLabel: "Timeout", opacityLabel: "Opacity", modeLabel: "Mode", langLabel: "Language", statusLabel: "Status", on: "ON", off: "OFF", mute3: "3 min", mute30: "30 min", mute60: "1 hour", muteOff: "Turn off", muteRemaining: "Muted {0}m left" },
  ja: { dismissBtn: " 閉じる ", continueBtn: " 続 行 ", completion: "完了", switchBack: "戻れます", enabled: "通知ON 🔔", disabled: "通知OFF 🔕", configTitle: "通知設定", timeoutLabel: "タイムアウト", opacityLabel: "不透明度", modeLabel: "モード", langLabel: "言語", statusLabel: "状態", on: "ON", off: "OFF", mute3: "3 分", mute30: "30 分", mute60: "1 時間", muteOff: "オフ", muteRemaining: "通知停止 残り{0}分" },
  ko: { dismissBtn: "  닫 기  ", continueBtn: " 계 속 ", completion: "완료", switchBack: "돌아가기", enabled: "알림 ON 🔔", disabled: "알림 OFF 🔕", configTitle: "알림 설정", timeoutLabel: "시간제한", opacityLabel: "불투명도", modeLabel: "모드", langLabel: "언어", statusLabel: "상태", on: "ON", off: "OFF", mute3: "3 분", mute30: "30 분", mute60: "1 시간", muteOff: "끄기", muteRemaining: "방해금지 {0}분 남음" },
};
function t(key: string): string { return i18n[config.lang]?.[key] ?? i18n.zh[key] ?? key; }
function completionMsg(): string { return `${t("completion")}，${t("switchBack")} 🎉`; }

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
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

// ── 窗口句柄缓存（koffi 直调 user32.dll）────────────────────────────
let terminalHwnd = "";
let terminalTitle = "";

function cacheTerminalHwnd(): void {
  if (platform() !== "win32" || !GetForegroundWindow) return;
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return;
    const len = GetWindowTextLengthW(hwnd);
    if (len > 0) {
      const buf = Buffer.alloc((len + 1) * 2);
      GetWindowTextW(hwnd, buf, len + 1);
      terminalTitle = buf.toString("utf16le").replace(/\0+$/, "");
    }
    terminalHwnd = String(hwnd);
    log(`cached terminal: hwnd=${terminalHwnd} title="${terminalTitle}"`);
  } catch (e: unknown) {
    log(`FAIL cache hwnd: ${e}`);
  }
}

// ── 窗口标识 ─────────────────────────────────────────────────────────────────
function generateWindowId(): string {
  return `pi@${process.pid.toString(36)}`;
}

function setWindowTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

// ── 调试日志 ─────────────────────────────────────────────────────────────────
const LOG = join(tmpdir(), "pi-notify-debug.log");
function log(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG, `[${ts}] ${msg}\n`, "utf-8"); } catch { /* ignore */ }
}

// ── 常驻 PowerShell 通知宿主（host.ps1 独立文件，一次编译，后续 stdin 一行即弹）

function spawnHost(): void {
  if (platform() !== "win32") return;
  if (psHost) {
    try { psHost.kill(); } catch { /* */ }
    psHost = null;
  }
  psHostReady = false;

  log("spawning PS host...");
  const psPath = join(__dirname, "host.ps1");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", psPath,
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf-8");
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "READY") {
        psHostReady = true;
        psHostCrashCount = 0;
        psHostLastError = "";
        log("PS host ready");
      } else if (trimmed === "OK") {
        log("PS host: notification dismissed");
      } else if (trimmed.startsWith("ERROR:")) {
        log(`PS host error: ${trimmed}`);
      } else if (trimmed.startsWith("MUTE:")) {
        const mins = parseInt(trimmed.slice(5));
        if (mins > 0) {
          enabled = false;
          saveMuteUntil(Date.now() + mins * 60000);
          log(`mute: notifications off for ${mins}m`);
        } else {
          enabled = true;
          saveMuteUntil(undefined);
          log("mute off");
        }
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    log(`PS host stderr: ${chunk.toString("utf-8").trim()}`);
  });

  child.on("close", (code) => {
    log(`PS host exited (code=${code})`);
    if (code !== 0 && code !== null) {
      psHostCrashCount++;
      psHostLastError = `exit code ${code}`;
      if (piApi?.ui) {
        piApi.ui.notify(`桌面通知服务异常 (${psHostLastError})，下次弹窗时自动恢复`, "warning");
      }
    }
    psHost = null;
    psHostReady = false;
  });

  child.on("error", (err) => {
    log(`PS host spawn error: ${err.message}`);
    psHost = null;
    psHostReady = false;
  });

  psHost = child;
}

// ── 桌面通知 ────────────────────────────────────────────────────────────────

function notifyWindows(title: string, body: string, hwnd: string, winTitle: string): void {
  log(`notifyWindows: title="${title}" hwnd=${hwnd} win="${winTitle}"`);

  if (!hwnd || hwnd === "0") {
    log("no valid hwnd, skipping");
    return;
  }

  if (!psHost || !psHostReady) {
    log(`PS host not ready (host=${!!psHost}, ready=${psHostReady}), respawning...`);
    spawnHost();
    return;
  }

  const elapsedLabel = taskStartTime > 0 ? `⏱ ${formatElapsed(Date.now() - taskStartTime)}` : "";

  const payload = JSON.stringify({
    title,
    body,
    hwnd,
    winTitle,
    dismissLabel: t("dismissBtn"),
    continueLabel: t("continueBtn"),
    mute3Label: t("mute3"),
    mute30Label: t("mute30"),
    mute60Label: t("mute60"),
    muteOffLabel: t("muteOff"),
    timeoutSec: config.timeout,
    opacityVal: config.opacity.toFixed(2),
    elapsedLabel,
  });

  try {
    psHost.stdin!.write(payload + "\n");
    log("notify payload sent to PS host");
  } catch (e: unknown) {
    log(`notify stdin write failed: ${e}`);
    spawnHost();
  }
}

function notifyMacOS(title: string, body: string): void {
  spawn("osascript", [
    "-e",
    `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
  ], { detached: true, stdio: "ignore" }).unref();
}

function notifyLinux(title: string, body: string): void {
  spawn("notify-send", [title, body], { detached: true, stdio: "ignore" }).unref();
}

function showNotification(title: string, body: string): void {
  if (process.env.KITTY_WINDOW_ID) {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
  } else if (process.env.GHOSTTY_RESOURCES_DIR ||
             process.env.ITERM_SESSION_ID ||
             process.env.WEZTERM_PANE) {
    process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
  } else if (platform() === "win32") {
    notifyWindows(title, body, terminalHwnd, uniqueWindowId);
  } else if (platform() === "darwin") {
    notifyMacOS(title, body);
  } else {
    notifyLinux(title, body);
  }
}

// ── 提取通知标题 ──────────────────────────────────────────────────────────

function extractPromptTitle(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      const role = (entry.role ?? msg?.role) as string | undefined;
      if (role === "user") {
        const content = (entry.content ?? msg?.content);
        const text = extractText(content);
        if (text) {
          const cleaned = text.replace(/\s+/g, " ").trim();
          return cleaned.length > 10
            ? cleaned.slice(0, 25) + "…"
            : cleaned;
        }
        break;
      }
    }
  } catch { /* fallback */ }
  return "pi";
}

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

// ── 前台检测（koffi 直调 GetForegroundWindow）─────────────────────

function isTerminalForeground(): boolean {
  if (platform() !== "win32" || !terminalHwnd || terminalHwnd === "0" || !GetForegroundWindow) {
    return false;
  }
  try {
    const fgHwnd = String(GetForegroundWindow());
    const match = fgHwnd === terminalHwnd;
    log(`fg-check: foreground=${fgHwnd} match=${match}`);
    return match;
  } catch {
    return false;
  }
}

// ── 异常结束检测 ──────────────────────────────────────────────────────────

const RETRY_PATTERN = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

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

function willRetry(msg: { stopReason?: string; errorMessage?: string }): boolean {
  if (msg.stopReason !== "error" || !msg.errorMessage) return false;
  return RETRY_PATTERN.test(msg.errorMessage);
}

// ── 扩展入口 ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  log("extension loaded");
  piApi = pi;
  initWin32();
  uniqueWindowId = `pi@${process.pid.toString(36)}`;
  process.stdout.write(`\x1b]0;${uniqueWindowId}\x07`);
  log(`windowId = ${uniqueWindowId}`);
  cacheTerminalHwnd();

  // 恢复上次未过期的勿扰（仅设置状态，到期检查由 agent_end 处理）
  if (config.muteUntil && config.muteUntil > Date.now()) {
    enabled = false;
    log(`mute restored: ${Math.round((config.muteUntil - Date.now()) / 60000)}m remaining`);
  }

  spawnHost();

  // ── /notify 命令 ──────────────────────────────────────────────────────────
  pi.registerCommand("notify", {
    description: "开关/配置桌面通知",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      const wantsNextLevel = prefix.endsWith(" ");

      if (parts.length === 0 || (parts.length === 1 && !wantsNextLevel)) {
        const subs = ["on", "off", "timeout", "opacity", "message", "lang", "status"];
        const filtered = subs.filter((s) => s.startsWith(parts[0] ?? ""));
        return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
      }
      const sub = parts[0];
      const val = parts[1] ?? "";
      if (sub === "timeout") {
        return ["5", "10", "15", "20", "30", "60"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: `${s}s` }));
      }
      if (sub === "opacity") {
        return ["0.5", "0.6", "0.7", "0.8", "0.9", "1.0"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s }));
      }
      if (sub === "message") {
        return ["fixed", "response"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s === "response" ? "AI reply (20 chars)" : "Fixed text" }));
      }
      if (sub === "lang") {
        return ["zh", "en", "ja", "ko"].filter((s) => s.startsWith(val)).map((s) => ({ value: `${sub} ${s}`, label: s }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const raw = args?.trim() ?? "";
      const parts = raw.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const val = parts.slice(1).join(" ").toLowerCase();

      if (!sub) {
        enabled = !enabled;
        ctx.ui.notify(enabled ? t("enabled") : t("disabled"), "info");
        return;
      }

      if (sub === "on" || sub === "1" || sub === "true") { enabled = true; ctx.ui.notify(t("enabled"), "info"); return; }
      if (sub === "off" || sub === "0" || sub === "false") { enabled = false; ctx.ui.notify(t("disabled"), "info"); return; }

      if (sub === "timeout") {
        const n = parseInt(val);
        if (n >= 5 && n <= 60) { config.timeout = n; saveConfig(config); ctx.ui.notify(`Timeout=${n}s`, "info"); }
        else { ctx.ui.notify("timeout: 5~60", "warning"); }
        return;
      }

      if (sub === "opacity") {
        const n = parseFloat(val);
        if (n >= 0.3 && n <= 1.0) { config.opacity = n; saveConfig(config); ctx.ui.notify(`Opacity=${n}`, "info"); }
        else { ctx.ui.notify("opacity: 0.3~1.0", "warning"); }
        return;
      }

      if (sub === "message") {
        if (val === "fixed" || val === "response") {
          config.messageMode = val; saveConfig(config);
          ctx.ui.notify(`Message=${val}`, "info");
        } else { ctx.ui.notify("Usage: /notify message fixed|response", "warning"); }
        return;
      }

      if (sub === "lang") {
        if (i18n[val]) { config.lang = val as typeof config.lang; saveConfig(config); ctx.ui.notify(`Language=${val}`, "info"); }
        else { ctx.ui.notify("Available: zh en ja ko", "warning"); }
        return;
      }

      // /notify status
      if (sub === "status") {
        // 同步检查勿扰过期
        if (config.muteUntil && Date.now() > config.muteUntil) {
          enabled = true;
          saveMuteUntil(undefined);
          log("mute expired (checked on status)");
        }
        const daemonStatus = psHostReady ? "Daemon OK" : "Daemon Down";
        let muteInfo = "";
        if (!enabled && config.muteUntil && config.muteUntil > Date.now()) {
          const remaining = Math.round((config.muteUntil - Date.now()) / 60000);
          muteInfo = " " + t("muteRemaining").replace("{0}", remaining.toString());
        }
        ctx.ui.notify(
          `${enabled ? t("enabled") : t("disabled")} | Timeout=${config.timeout}s Opacity=${config.opacity} Mode=${config.messageMode} Language=${config.lang} ${daemonStatus}${muteInfo}`,
          psHostReady ? "info" : "warning",
        );
        return;
      }

      ctx.ui.notify(`Unknown: ${raw} — try /notify status`, "warning");
    },
  });

  // ── 事件 ──────────────────────────────────────────────────────────────────
  pi.on("session_start", async () => {
    log("session_start");
  });

  let isCompacting = false;
  pi.on("session_before_compact", () => { isCompacting = true; log("compaction started"); });
  pi.on("session_compact", () => { isCompacting = false; log("compaction ended"); });

  pi.on("agent_start", () => {
    taskStartTime = Date.now();
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
      log(`agent_start: cancelled pending notification`);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    // 实时检查勿扰过期（每次 agent_end 读文件，跨实例自动同步）
    if (config.muteUntil && Date.now() > config.muteUntil) {
      enabled = true;
      saveMuteUntil(undefined);
      log("mute expired (checked on agent_end)");
    }

    log(`agent_end: enabled=${enabled} compacting=${isCompacting}`);
    if (!enabled || isCompacting) return;

    const msg = getLastAssistantMessage(_event);
    if (msg) log(`agent_end: stopReason=${msg.stopReason} error=${!!msg.errorMessage}`);

    if (msg) {
      if (msg.stopReason === "aborted") { log("aborted, skip"); return; }
      if (msg.stopReason === "error" && !willRetry(msg)) { log("non-retryable error, skip"); return; }
    }

    const title = extractPromptTitle(ctx);

    if (notifyTimer) clearTimeout(notifyTimer);
    const delay = (msg && willRetry(msg)) ? 10000 : 2000;
    log(`agent_end: delay=${delay}ms`);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (isCompacting) { log("compaction in progress, skip"); return; }
      const inForeground = isTerminalForeground();
      log(`foreground: ${inForeground}`);
      if (inForeground) return;
      const body = config.messageMode === "response"
        ? extractSummary(_event) ?? completionMsg()
        : completionMsg();
      log(`notification: "${title}" body="${body}"`);
      showNotification(title, body);
    }, delay);
  });
}
