// Postinstall: ensure koffi's native module is findable despite npm hoisting
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { platform } from "node:os";

if (platform() !== "win32") process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(__dirname); // pi-win-notify root

// Source: where npm hoisted the native module (top-level node_modules)
const src = join(pkgDir, "..", "..", "node_modules", "@koromix", "koffi-win32-x64");
// Dest: where koffi expects it (inside pi-win-notify/node_modules)
const destDir = join(pkgDir, "node_modules", "@koromix");
const dest = join(destDir, "koffi-win32-x64");

if (existsSync(dest)) {
  console.log("[pi-win-notify] koffi native module already linked, skip");
  process.exit(0);
}

if (!existsSync(src)) {
  console.log("[pi-win-notify] koffi native module not found at top level, skip");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
execSync(`mklink /J "${dest}" "${src}"`, { stdio: "pipe" });
console.log("[pi-win-notify] linked koffi native module");
