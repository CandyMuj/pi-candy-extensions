/**
 * Path helpers shared by config / exclude / storage / tracker.
 *
 * Stored paths (keys in state.json) use forward slashes:
 * - files inside cwd -> path relative to cwd (e.g. "src/index.ts")
 * - files outside cwd -> absolute path (e.g. "C:/other/file.txt" or "/etc/hosts")
 *
 * Forward slashes keep minimatch semantics correct on Windows and make state
 * files portable between platforms.
 */

import { homedir } from "node:os";
import path from "node:path";

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** Normalize for case-insensitive comparison on Windows. */
export function normalizeForCompare(input: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize(input);
  return isWindows(platform) ? normalized.toLowerCase() : normalized;
}

/** True when `child` equals `parent` or lives inside `parent`. */
export function isSameOrInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const rel = path.relative(normalizeForCompare(parent, platform), normalizeForCompare(child, platform));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Convert to forward-slash form (used for stored paths and glob matching). */
export function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

/** Absolute path -> stored path (relative inside cwd, absolute outside). */
export function toStoredPath(
  cwd: string,
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isSameOrInside(cwd, absolutePath, platform)) {
    const rel = path.relative(cwd, absolutePath);
    return toPosix(rel);
  }
  return toPosix(path.resolve(absolutePath));
}

/** Stored path -> absolute path. */
export function fromStoredPath(cwd: string, storedPath: string): string {
  if (path.isAbsolute(storedPath) || /^[A-Za-z]:[\\/]/.test(storedPath)) {
    return path.normalize(storedPath);
  }
  return path.resolve(cwd, storedPath);
}

/** Expand a leading `~` (and `~/`, `~\`) using the given home directory. */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** Strip a leading "@" that some models add to path arguments. */
export function stripAtPrefix(input: string): string {
  return input.startsWith("@") ? input.slice(1) : input;
}
