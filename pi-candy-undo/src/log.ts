/**
 * Debug logging (docs/design.md §4, §7 `log`).
 *
 * Writes to `<storageDir>/undo.log` when enabled. Logging must never throw and
 * never block the agent: failures are silently ignored.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./types.ts";

export function createLogger(options: { logFile: string; enabled: boolean; tag?: string }): Logger {
  const tag = options.tag ?? "undo";
  if (!options.enabled) {
    return { log: () => {} };
  }
  let ensured = false;
  const ensureDir = async (): Promise<void> => {
    if (ensured) {
      return;
    }
    ensured = true;
    await mkdir(path.dirname(options.logFile), { recursive: true });
  };
  return {
    log(line: string): void {
      const text = `[${new Date().toISOString()}] [${tag}] ${line}\n`;
      void ensureDir()
        .then(() => appendFile(options.logFile, text, "utf8"))
        .catch(() => {});
    },
  };
}
