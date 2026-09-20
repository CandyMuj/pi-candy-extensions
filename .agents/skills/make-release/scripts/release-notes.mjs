#!/usr/bin/env node
/**
 * release-notes.mjs — 多插件 monorepo 的 release notes 机械草案生成器（只读，不改任何文件）
 *
 * 用法：
 *   node release-notes.mjs [--markdown] [--tag <tag>] [prev] [new]
 *     prev  上一个 release tag（缺省 = 最近一个 release-* tag；没有则从首个提交起算，标「首个 release」）
 *     new   新 tag 或提交（缺省 = HEAD）
 *     --tag 用作 Markdown 标题的 tag 名（缺省 = release-<今天日期 YYYY.MM.DD>）
 *     --markdown 输出固定模板的 Markdown 草案（提交清单，待模型改写为总结）；缺省输出 JSON
 *
 * 顺序与版本全部从仓库文件读取，不硬编码：
 *   - 插件顺序 = 根 README.md「插件列表」表格顺序
 *   - 工具顺序 = pi-candy-toolbox/extensions/index.ts 的 TOOLS 数组顺序
 *   - 版本 = 各 ref 下 package.json 的 version
 * 版本闸门：插件有「功能改动」（extensions/src/themes/scripts 等发布内容）但版本号未升 → 输出告警。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 执行 git（Windows 下 git.exe 可直接 execFile，无需 shell） */
function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trimEnd(), err: (result.stderr ?? "").trim() };
}

/** 读某 ref 下的文件内容；不存在返回 null */
function readAt(ref, path) {
  const r = git(["show", `${ref}:${path}`]);
  return r.ok ? r.out : null;
}

/** 读某 ref 下某插件的 package.json；不存在返回 null */
function pkgAt(ref, dir) {
  const raw = readAt(ref, `${dir}/package.json`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** camelCase 标识符 → kebab-case 工具 id（sessionTitle → session-title） */
function camelToKebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** 从根 README「插件列表」表格读插件顺序 */
function pluginOrder(newRef) {
  const readme = readAt(newRef, "README.md");
  if (readme === null) return [];
  const list = [];
  for (const line of readme.split("\n")) {
    const m = /^\| \[(pi-candy-[a-z-]+)\]/.exec(line);
    if (m) list.push(m[1]);
  }
  return list;
}

/** 从 TOOLS 数组读工具顺序（追加式约定） */
function toolOrder(newRef) {
  const src = readAt(newRef, "pi-candy-toolbox/extensions/index.ts");
  if (src === null) return [];
  const m = /const TOOLS[^\n]*\[([\s\S]*?)\n\]/.exec(src);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\w+,?$/.test(line))
    .map((line) => camelToKebab(line.replace(/,+$/, "")));
}

/** 一个提交改动的文件列表 */
function filesOf(hash) {
  const r = git(["show", "--name-only", "--format=", hash]);
  return r.ok ? r.out.split("\n").filter(Boolean) : [];
}

/** toolbox 文件路径 → 工具 id（不属于任何工具则 null） */
function toolOfPath(path) {
  let m;
  if ((m = /^pi-candy-toolbox\/extensions\/tools\/([^/]+)\.ts$/.exec(path)) && m[1] !== "_template") return m[1];
  if ((m = /^pi-candy-toolbox\/extensions\/tools\/([^/]+)\//.exec(path)) && m[1] !== "_template") return m[1];
  if ((m = /^pi-candy-toolbox\/tests\/([^/]+)\.test\.ts$/.exec(path)) && m[1] !== "$toolbox") return m[1];
  if ((m = /^pi-candy-toolbox\/tests\/([^/]+)\//.exec(path)) && m[1] !== "$toolbox") return m[1];
  if ((m = /^pi-candy-toolbox\/docs\/([^/]+)\.md$/.exec(path))) return m[1];
  return null;
}

/** 是否「功能改动」：发布内容（extensions/src/themes/scripts），docs/README/package.json/LICENSE 不算 */
function isFunctional(path, pluginDir) {
  const rel = path.startsWith(`${pluginDir}/`) ? path.slice(pluginDir.length + 1) : path;
  return /^(extensions|src|themes|scripts)\//.test(rel);
}

function main() {
  const args = process.argv.slice(2);
  const wantMd = args.includes("--markdown");
  // 解析位置参数（prev / new）与 --tag 的值，避免把 --tag 的值误当 prev
  let tagArg = "";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--markdown") continue;
    if (args[i] === "--tag") {
      tagArg = args[i + 1] ?? "";
      i++;
      continue;
    }
    positional.push(args[i]);
  }

  const newRef = positional[1] ?? "HEAD";
  let prevRef = positional[0] ?? "";
  if (!prevRef) {
    const tags = git(["tag", "-l", "release-*"]).out
      .split("\n")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    prevRef = tags.at(-1) ?? "";
  }
  const firstCommit = git(["rev-list", "--max-parents=0", "HEAD"]).out.split("\n")[0] ?? "";
  const firstRelease = !prevRef;
  if (!prevRef) prevRef = firstCommit;

  const today = new Date().toISOString().slice(0, 10).replaceAll("-", ".");
  const tagName = tagArg || `release-${today}`;

  const plugins = pluginOrder(newRef);
  const tools = toolOrder(newRef);

  // 收集提交（含文件），再按插件/工具分类
  // 注意：git log A..B 会排除 A 可达的提交；首个 release（prev=首个提交）时用 rev-list 列出全部提交，
  // 否则会漏掉最初的提交。
  const logResult = firstRelease
    ? git(["rev-list", "--format=%H%x1e%s", "--no-merges", "HEAD"])
    : git(["log", "--no-merges", "--format=%H%x1e%s", `${prevRef}..${newRef}`]);
  const commits = logResult.ok
    ? logResult.out.split("\n").filter(Boolean).flatMap((line) => {
        // rev-list 输出是 "commit <hash>" 行 + 格式化行，丢弃 commit 行
        const sep = line.indexOf("\x1e");
        if (sep === -1) return [];
        return [{ hash: line.slice(0, sep), subject: line.slice(sep + 1), files: [] }];
      })
    : [];

  // 先为每个插件建条目（无更新的也要列出）
  const pluginEntries = plugins.map((name) => ({
    name,
    oldVersion: pkgAt(prevRef, name)?.version ?? null,
    newVersion: pkgAt(newRef, name)?.version ?? null,
    commits: [], // 全部提交（含工具提交，用于文件统计）
    pluginCommits: [], // 插件级提交
    tools: {}, // toolId → commits
    functionalChanges: false,
  }));
  const other = [];

  for (const c of commits) {
    c.files = filesOf(c.hash);
    const owner = plugins.find((p) => c.files.some((f) => f.startsWith(`${p}/`)));
    if (!owner) {
      other.push(c);
      continue;
    }
    const entry = pluginEntries.find((e) => e.name === owner);
    entry.commits.push(c);
    let tool = null;
    if (owner === "pi-candy-toolbox") {
      for (const f of c.files) {
        const id = toolOfPath(f);
        if (id) {
          tool = id;
          break;
        }
      }
    }
    if (tool) {
      (entry.tools[tool] ??= []).push(c);
    } else {
      entry.pluginCommits.push(c);
    }
    if (c.files.some((f) => isFunctional(f, owner))) entry.functionalChanges = true;
  }

  // 版本闸门
  const gates = pluginEntries
    .filter((e) => e.functionalChanges && e.newVersion !== null && e.newVersion === e.oldVersion)
    .map((e) => `${e.name}：有功能改动但版本未升（${e.oldVersion ?? "?"} → ${e.newVersion ?? "?"}）`);

  const result = {
    tag: tagName,
    prev: firstRelease ? null : prevRef,
    new: newRef,
    firstRelease,
    tools,
    gates,
    plugins: pluginEntries,
    other,
  };

  if (!wantMd) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ── Markdown 草案 ──
  const short = (h) => h.slice(0, 7);
  const bullet = (c) => `- ${c.subject} (#${short(c.hash)})`;
  const lines = [];
  lines.push(`# ${tagName}`);
  lines.push("");
  lines.push(
    `> 相对上一次 release：${firstRelease ? "**首个 release**（自首个提交起算）" : `\`${result.prev}\``}`,
  );
  if (gates.length > 0) {
    lines.push("");
    lines.push("> ⚠️ **版本闸门告警（需先处理再打 tag）**：");
    for (const g of gates) lines.push(`> - ${g}`);
  }
  lines.push("");
  lines.push("## 版本总表");
  lines.push("");
  lines.push("| 插件 | 本次版本 | 相对上次 | 状态 |");
  lines.push("|---|---|---|---|");
  for (const e of pluginEntries) {
    const link = e.newVersion
      ? `[${e.name}](https://www.npmjs.com/package/${e.name}/v/${e.newVersion})`
      : e.name;
    const prevText = firstRelease ? "—" : (e.oldVersion ?? "（新增）");
    const status = e.commits.length > 0 ? "有变更" : "无更新";
    lines.push(`| ${link} | ${e.newVersion ?? "—"} | ${prevText} | ${status} |`);
  }
  lines.push("");
  lines.push("## 各插件变更");
  for (const e of pluginEntries) {
    lines.push("");
    lines.push(`### ${e.name} ${e.newVersion ?? "（无版本）"}`);
    if (e.commits.length === 0) {
      lines.push("");
      lines.push("无更新。");
      continue;
    }
    if (e.pluginCommits.length > 0) {
      lines.push("");
      for (const c of e.pluginCommits) lines.push(bullet(c));
    }
    if (e.name === "pi-candy-toolbox") {
      for (const tool of tools) {
        const tcs = e.tools[tool] ?? [];
        lines.push("");
        lines.push(`#### ${tool}${tcs.length === 0 ? " — 无更新" : ""}`);
        for (const c of tcs) lines.push(bullet(c));
      }
      // 不在 TOOLS 数组里却出现过的工具（异常情况，追加在最后）
      for (const [tool, tcs] of Object.entries(e.tools)) {
        if (tools.includes(tool)) continue;
        lines.push("");
        lines.push(`#### ${tool}（不在 TOOLS 数组中）`);
        for (const c of tcs) lines.push(bullet(c));
      }
    }
  }
  if (other.length > 0) {
    lines.push("");
    lines.push("## 仓库公共");
    lines.push("");
    for (const c of other) lines.push(bullet(c));
  }
  console.log(lines.join("\n"));
}

main();
