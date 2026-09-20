#!/usr/bin/env node
/**
 * preflight.mjs — npm 发布前的只读检查（不会发布任何东西）
 *
 * 用法：
 *   node .agents/skills/npm-publish/scripts/preflight.mjs                 # 全部包
 *   node .agents/skills/npm-publish/scripts/preflight.mjs toolbox undo    # 指定短名 / 包名 / 目录名
 *
 * 检查项（全部只读或 dry-run）：
 *   1. npm whoami --registry=<官方源>
 *   2. 线上版本（E404 = 未发布；与本地版本比对，同版本已存在会阻塞发布）
 *   3. npm pack --dry-run → 打包内容概要 + 文件列表核查（缺失 / 可疑文件 / files 路径是否存在）
 *   4. npm publish --dry-run → 模拟发布结果
 *   5. 元数据核查：必填字段、LICENSE 文件、peerDependencies 是否覆盖运行时 import 的 pi 核心包
 *
 * 退出码：0 = 可发布；2 = 阻塞项（未登录 / registry 未指向官方源 / 版本已存在 / dry-run 失败）；
 *         3 = 无阻塞但有待修正项（元数据或文件列表）；1 = 参数或环境错误。
 *
 * 本脚本不提供任何跳过检查的开关（无环境变量、无 --force）：未登录时直接退出 2，
 * 由调用方停下来向用户确认（重新登录），不得自行绕过检查。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** pi 打包内置、应声明在 peerDependencies 的核心包 */
const PI_CORE_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
];
/** npm 发布元数据的必填字段 */
const REQUIRED_FIELDS = ["name", "version", "description", "license", "author", "repository", "keywords", "files", "pi"];

/** 运行命令并返回 { ok, out }（out = stdout + stderr）
 *  用整条命令字符串 + shell：Windows 下 npm 是 npm.cmd，无法直接 execFile；
 *  参数全部来自本地 package.json / 固定常量，不含用户输入，无注入面。
 */
function run(args, cwd = REPO_ROOT) {
  const result = spawnSync(["npm", ...args].join(" "), {
    cwd,
    encoding: "utf8",
    shell: true,
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** 仓库内所有待发布包（根目录下带 package.json 的目录，排除 .pi / node_modules） */
function listPackages() {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => join(REPO_ROOT, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { dir, pkg, name: pkg.name, version: pkg.version, publishRegistry: pkg.publishConfig?.registry };
    })
    .filter((entry) => typeof entry.name === "string" && typeof entry.version === "string")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 短名匹配：themes / win-notify / toolbox / undo 或完整包名或目录名 */
function matchPackages(all, args) {
  if (args.length === 0) return { matched: all, unknown: [] };
  const matched = [];
  const unknown = [];
  for (const arg of args) {
    const key = arg.replace(/^pi-candy-/, "").toLowerCase();
    const hit = all.find(
      (pkg) =>
        pkg.name.toLowerCase() === arg.toLowerCase() ||
        pkg.name.toLowerCase() === `pi-candy-${key}` ||
        pkg.name.replace(/^pi-candy-/, "").toLowerCase() === key,
    );
    if (hit) {
      if (!matched.includes(hit)) matched.push(hit);
    } else {
      unknown.push(arg);
    }
  }
  return { matched, unknown };
}

/** 从 `npm pack --dry-run` 输出里提取内容、体积与文件名列表 */
function parsePackSummary(out) {
  const line = (re) => out.split("\n").find((l) => re.test(l))?.replace(/^npm notice\s*/, "").trim();
  const contents = out
    .split("\n")
    .map((l) => /^npm notice\s+(\d+(?:\.\d+)?(?:B|kB|MB))\s+(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ size: m[1], path: m[2].trim() }));
  return {
    package: line(/^npm notice package:/),
    files: line(/total files:/)?.replace("total files:", "").trim(),
    size: line(/package size:/)?.replace("package size:", "").trim(),
    unpacked: line(/unpacked size:/)?.replace("unpacked size:", "").trim(),
    contents,
  };
}

/** 扫描随包发布的源码，收集运行时 import 的 pi 核心包（排除 import type） */
function runtimePiImports(pkgDir, contents) {
  const found = new Map(); // 包名 → 首次出现的文件
  const importRe = /^[ \t]*import\s+(?!type\s)([\s\S]*?)\s+from\s+["'](@earendil-works\/[^"']+)["']/gm;
  for (const item of contents) {
    if (!/\.(ts|js|mjs|cjs)$/.test(item.path)) continue;
    const file = join(pkgDir, item.path);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const spec = match[2];
      if (PI_CORE_PACKAGES.includes(spec) && !found.has(spec)) found.set(spec, item.path);
    }
  }
  return found;
}

/** 元数据与文件列表核查 */
function checkMetadata(pkg, contents) {
  const warnings = [];

  for (const field of REQUIRED_FIELDS) {
    if (pkg.pkg[field] === undefined) warnings.push(`package.json 缺字段 "${field}"`);
  }
  if (Array.isArray(pkg.pkg.keywords) && !pkg.pkg.keywords.includes("pi-package")) {
    warnings.push('keywords 缺 "pi-package"（pi 包画廊靠它检索）');
  }
  const licenseFile = readdirSync(pkg.dir).find((name) => /^licen[cs]e($|\.)/i.test(name));
  if (!licenseFile) warnings.push("包目录内没有 LICENSE 文件（tarball 不会带许可证正文）");

  // files 白名单里的路径必须真实存在（防拼写错误）
  for (const entry of pkg.pkg.files ?? []) {
    if (!existsSync(join(pkg.dir, entry))) warnings.push(`files 中的 "${entry}" 在磁盘上不存在`);
  }

  // peerDependencies 覆盖运行时 import 的 pi 核心包
  const declared = new Set([...Object.keys(pkg.pkg.peerDependencies ?? {}), ...Object.keys(pkg.pkg.dependencies ?? {})]);
  for (const [spec, file] of runtimePiImports(pkg.dir, contents)) {
    if (!declared.has(spec)) warnings.push(`运行时 import ${spec}（${file}）但未声明在 peerDependencies`);
  }
  // 声明为 peer 的 pi 核心包应标 optional：pi 运行时用 loader alias 提供，
  // 不标则 npm 会给纯 npm 用户 / 开发机自动装一份 400MB+ 副本
  for (const spec of Object.keys(pkg.pkg.peerDependencies ?? {})) {
    if (PI_CORE_PACKAGES.includes(spec) && pkg.pkg.peerDependenciesMeta?.[spec]?.optional !== true) {
      warnings.push(`peerDependencies 中的 ${spec} 未标 optional（建议 peerDependenciesMeta.<pkg>.optional = true）`);
    }
  }

  // 不该出现在发布物里的文件
  const suspicious = [
    [/^node_modules\//, "node_modules"],
    [/^tests?\//, "测试目录"],
    [/\.env(\.|$)/, "环境变量文件"],
    [/\.log$/, "日志文件"],
    [/(^|\/)\.(git|npmrc|DS_Store)/, "隐藏/配置文件"],
  ];
  for (const item of contents) {
    for (const [re, label] of suspicious) {
      if (re.test(item.path)) warnings.push(`发布物含${label}：${item.path}`);
    }
  }

  return warnings;
}

function main() {
  const all = listPackages();
  const { matched, unknown } = matchPackages(all, process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`✖ 无法识别的目标：${unknown.join(", ")}\n  可用：${all.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`发布前检查（只读 + dry-run，不发布）｜registry: ${REGISTRY}\n`);

  // 1. 登录
  const whoami = run(["whoami", `--registry=${REGISTRY}`]);
  const user = whoami.out.trim();
  if (!whoami.ok) {
    console.error(`✖ 未登录官方源（凭据缺失或已失效）：${user.split("\n")[0]}`);
    console.error(`  请用户执行：npm login --registry=${REGISTRY}`);
    console.error("  凭据问题需向用户确认，不要绕过登录检查。");
    process.exit(2);
  }
  console.log(`✔ 已登录：${user}\n`);

  const rows = [];
  const blockers = [];
  const fixes = [];
  for (const pkg of matched) {
    console.log(`── ${pkg.name}@${pkg.version}`);

    if (pkg.publishRegistry !== REGISTRY) {
      blockers.push(`${pkg.name}：publishConfig.registry = ${pkg.publishRegistry ?? "(未设置)"}，不是官方源`);
    }

    // 2. 线上版本
    const online = run(["view", pkg.name, "version", `--registry=${REGISTRY}`]);
    let onlineVersion = null;
    if (online.ok) {
      onlineVersion = online.out.trim();
      if (onlineVersion === pkg.version) {
        blockers.push(`${pkg.name}：线上已有 ${onlineVersion}，需升版本号后再发`);
      }
    } else if (/E404/.test(online.out)) {
      onlineVersion = "未发布（首发布）";
    } else {
      blockers.push(`${pkg.name}：查询线上版本失败 — ${online.out.split("\n")[0]}`);
    }
    console.log(`   线上版本：${onlineVersion}`);

    // 3. 打包内容
    let contents = [];
    const pack = run(["pack", "--dry-run"], pkg.dir);
    if (!pack.ok) {
      blockers.push(`${pkg.name}：npm pack --dry-run 失败`);
      console.log(`   ✖ pack 失败：${pack.out.split("\n").find((l) => l.trim()) ?? ""}`);
    } else {
      const summary = parsePackSummary(pack.out);
      contents = summary.contents;
      console.log(`   打包内容：${summary.files} 个文件，${summary.size}（解开 ${summary.unpacked}）`);
      for (const item of contents) console.log(`     · ${item.size}  ${item.path}`);
    }

    // 4. 模拟发布
    const dry = run(["publish", "--dry-run"], pkg.dir);
    console.log(`   publish --dry-run：${dry.ok ? "通过" : "失败"}`);
    if (!dry.ok) {
      blockers.push(`${pkg.name}：npm publish --dry-run 失败`);
      for (const line of dry.out.split("\n").filter((l) => /npm error/.test(l)).slice(0, 5)) console.log(`     ${line}`);
    }

    // 5. 元数据与文件列表
    const warnings = contents.length > 0 ? checkMetadata(pkg, contents) : [];
    if (warnings.length > 0) {
      console.log("   元数据 / 文件列表待修正：");
      for (const item of warnings) {
        console.log(`     ⚠ ${item}`);
        fixes.push(`${pkg.name}：${item}`);
      }
    } else {
      console.log("   元数据 / 文件列表：通过");
    }

    rows.push({ name: pkg.name, local: pkg.version, online: onlineVersion, dryRun: dry.ok ? "ok" : "fail" });
    console.log("");
  }

  // 确认表
  console.log("确认表：");
  console.log("| 包名 | 本地版本 | 线上版本 | publish --dry-run |");
  console.log("|---|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.local} | ${row.online} | ${row.dryRun} |`);
  }

  if (blockers.length > 0) {
    console.log("\n阻塞项（必须处理后再发布）：");
    for (const item of blockers) console.log(`  ✖ ${item}`);
  }
  if (fixes.length > 0) {
    console.log(`\n待修正项 ${fixes.length} 条（建议发布前处理，见上）；确认无需处理后可由用户明确指示发布。`);
  }
  if (blockers.length > 0) process.exit(2);
  if (fixes.length > 0) process.exit(3);
  console.log("\n✔ 全部通过。真实发布需用户明确指示后逐包执行 npm publish。");
}

main();
