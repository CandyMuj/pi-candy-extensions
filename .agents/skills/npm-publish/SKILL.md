---
name: npm-publish
description: 把本仓库（pi-candy-extensions）的插件包发布到 npm 官方 registry 的完整流程——解析目标包、登录检查、发布前检查（pack/publish dry-run）、版本号升级、执行发布、发布后验证，全部为非 scoped 包。当用户要求「发布 / 发版 / 上线 / publish / 上传 npm」本仓库插件，或要做发布准备与检查（whoami、线上版本核对、dry-run、版本号）时使用；支持只处理指定插件（通过参数或提示词传包名 / 短名）。
---

# npm 发布流程（pi-candy-extensions）

## 适用范围

本仓库 4 个包 → npm 官方源（`registry.npmjs.org`），**全部非 scoped**：包名即 `pi-candy-*`，发布不需要 `--access`、不需要 scope 参数。目录名 == 包名 == `package.json` 的 `name`。

| 目录（= 包名） | 内容 | 自测命令 |
|---|---|---|
| `pi-candy-themes` | 主题包（`themes/`、`scripts/`） | `npm run build:themes`（生成物应无 diff） |
| `pi-candy-win-notify` | 扩展 + `postinstall`（装 koffi 平台二进制） | `node --experimental-strip-types tests/tests.ts` |
| `pi-candy-toolbox` | 工具箱扩展（`extensions/`、`docs/`） | `npm test` + `npm run typecheck` |
| `pi-candy-undo` | 撤销/重做扩展（`extensions/`、`src/`、`docs/`） | `npm test` + `npm run typecheck` |

环境事实（每次先核对，变了就更新本节）：

- 本机默认 registry 是镜像 `https://registry.npmmirror.com` → **所有查询类命令必须显式带** `--registry=https://registry.npmjs.org/`
- `npm publish` 不用手写 registry：各包 `package.json` 的 `publishConfig.registry` 已固定为官方源（这正是加它的原因）
- npmrc 中已有 `//registry.npmjs.org/:_authToken`，`npm whoami --registry=https://registry.npmjs.org/` 应输出 `candymuj`

## 铁律

1. **用户没有明确说要发布，就绝不执行 `npm publish`。**「检查一下」「dry-run 看看」「准备发布」「能不能发」都不算明确发布；准备阶段一律止于 `npm publish --dry-run`，把结果汇报给用户等指示。
2. 发布前必须逐包完成 §3 检查，并向用户给出确认表：包名 / 本地版本 / 线上版本 / 文件数与体积 / 自测结果。
3. `npm login` 是交互式命令：**不要自己尝试登录**。先 `npm whoami` 检查，未登录就请用户自己执行登录命令（见 §1）。
4. **不确定就问，不要绕过**：以下情况一律用**提问工具**（ask_user_question）向用户确认，不要自行假设、猜测或绕过：
   - 登录失效（`E401` / `ENEEDAUTH`，或 registry 可达但 `whoami` 返回 401）
   - 目标包名匹配不上或有歧义
   - 版本级别（patch / minor / major）未指定
   - preflight 报出待修正项（元数据 / 文件列表）而用户未必要求先修
   - 是否真正执行发布、发布前是否要先提交 / `git push`
   脚本不提供任何跳过登录或跳过检查的开关（无环境变量、无 `--force`），遇到这些情况就停下来问。
5. 不做破坏性操作：不加 `--force`、不改 git config、不擅自 `git push`。
6. 一个包失败不影响其余包：继续处理剩下的，最后统一汇报「成功 / 失败 + 原因」。

## 0. 解析目标包

- 从 skill 参数或提示词提取包名，支持短名：`themes`、`win-notify`、`toolbox`、`undo`，也支持完整包名 `pi-candy-*` 或目录名
- 未指定 → 默认全部 4 个（发布前仍需向用户确认清单）
- 匹配不上或有歧义 → 停下问用户，不要猜

## 1. 登录与身份

```bash
npm whoami --registry=https://registry.npmjs.org/
```

- 输出用户名（如 `candymuj`）→ 继续
- `ENEEDAUTH` / `E401`（含 registry 可达但 `whoami` 401 的情况）→ **停下来用提问工具问用户**，不要跳过登录检查、不要改动凭据、不要自行登录；并请用户执行：

```bash
npm login --registry=https://registry.npmjs.org/
```

## 2. 线上状态（只读）

```bash
npm view pi-candy-toolbox version --registry=https://registry.npmjs.org/
npm view pi-candy-toolbox versions --registry=https://registry.npmjs.org/
```

- `E404` → 该包尚未发布（首发布，包名未被占用）
- 记录线上版本，用来判断：需要升版本 / 待发版本是否已存在

## 3. 发布前检查（逐包，在包目录内）

```bash
cd pi-candy-toolbox
npm test && npm run typecheck     # 该包的自测，见上表
npm pack --dry-run                # 核对打包内容（文件数 / 体积 / 有无杂物）
npm publish --dry-run             # 模拟发布：不上传、不产生任何线上变更
```

检查点：

- `Tarball Contents` 与预期一致：`files` 白名单生效，没有 node_modules / tests / 日志 / .env 混入
- **元数据完整性**：`name` / `version` / `description` / `license` / `author` / `repository`（含 `directory` 指向子目录）/ `keywords`（含 `pi-package`）/ `files` / `pi` / `publishConfig.registry` 齐全；包目录内有 `LICENSE` 文件（npm 自动纳入 tarball）
- **文件列表**：`files` 里每个路径都真实存在（防拼写错）；README/文档引用到的资源（如 `docs/*.md`、`scripts/generate-themes.mjs`、`extensions/host.ps1`）都在白名单内，不能少也不能多带内部文件
- **依赖声明**：运行时 import 的 pi 核心包（`@earendil-works/pi-coding-agent`、`pi-tui`、`pi-ai`、`pi-agent-core`）必须声明在 `peerDependencies`（`"*"`），**并配套 `peerDependenciesMeta.<pkg>.optional = true`**；`import type` 不算运行时依赖。原因：pi 在 loader 层用 alias/virtual module 把这些包指向宿主自己的实现（`packages/coding-agent/src/core/extensions/loader.ts`），运行时根本不用扩展的 node_modules；标 `optional` 后 npm 不会自动装（纯 npm 用户与开发机少拉一份 400MB+ 副本），语义上是明确的「宿主提供」。需要本地 typecheck 时，把该包同时放进 `devDependencies`（如 `^0.85.1`）
- dry-run 显示的版本号 == 计划发布的版本号
- 线上已存在同版本 → 必须先升版本号，否则发布报 403

以上元数据/文件列表检查已由 preflight 脚本自动完成（见文末），人工只需确认输出里的 `⚠` 项。

## 4. 版本号

```bash
cd pi-candy-toolbox
npm version patch --no-git-tag-version   # 1.0.0 → 1.0.1
npm version minor --no-git-tag-version   # 1.0.0 → 1.1.0
npm version major --no-git-tag-version   # 1.0.0 → 2.0.0
```

- 版本级别用户没给 → 先问（见铁律 4）
- 线上 404（首发布）的包：当前版本号本来就没被占用，通常无需升版本；跟用户确认即可

**必须加 `--no-git-tag-version`**：本仓库是多包 monorepo，默认行为会给每个包各建同名 tag（`v1.0.1` 互相撞车）并各自产生一个 commit；改成只改 `package.json`，最后按仓库约定统一提交：

```bash
git add pi-candy-toolbox/package.json pi-candy-toolbox/package-lock.json
git commit -m "🔧 chore: pi-candy-toolbox 1.0.1"
```

有 lockfile 的包一并提交（`themes` 没有 lockfile；`win-notify` / `undo` 有）。`git push` 等用户指示。

## 5. 发布（仅在用户明确要求时）

逐包在各自目录执行，无额外参数：

```bash
cd pi-candy-toolbox && npm publish
cd ../pi-candy-undo && npm publish
```

- 非 scoped 包：**不要**加 `--access public`；不加 `--tag`（除非用户要求发 beta 等 dist-tag）
- 首次发布新包名同样只需 `npm publish`

## 6. 验证

```bash
npm view pi-candy-toolbox version --registry=https://registry.npmjs.org/
npm view pi-candy-toolbox dist.tarball --registry=https://registry.npmjs.org/
```

- 输出 == 刚发布的版本号
- 可选冒烟：`pi -e npm:pi-candy-toolbox`（临时试用，不写入配置）

## 7. 收尾汇报

给出结果表：包名 / 版本 / 结果（成功或失败原因） / 验证输出，并提示下一步（提交版本号、`git push`、README 是否需同步）。README 的安装命令（`pi install npm:<包名>`）在包名不变时无需改动。

## 辅助脚本

```bash
node .agents/skills/npm-publish/scripts/preflight.mjs                 # 全部包
node .agents/skills/npm-publish/scripts/preflight.mjs toolbox undo    # 指定短名 / 包名 / 目录名
```

脚本只做**只读 + dry-run**：whoami、线上版本（E404 = 未发布）、`pack --dry-run` 概要、`publish --dry-run` 结果、元数据与文件列表核查，最后打印确认表；**脚本内不含任何真实发布路径**（发布只能由人明确指示后手工执行 `npm publish`）。

退出码：`0` 全部通过｜`3` 无阻塞但有元数据/文件列表待修正项｜`2` 有阻塞项（registry 非官方源、版本已存在、dry-run 失败）｜`1` 参数或环境错误。

## 常见错误对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `E404`（`npm view`） | 包尚未发布 | 正常，属首发布 |
| `E403` cannot publish over the previously published versions | 线上已有同版本 | 升版本号后重发 |
| `E403` You do not have permission | 包名归属他人 / token 无权限 | 换包名或核对 npm 账号 |
| `ENEEDAUTH` / `E401` | 未登录 / token 失效 | 用户手动 `npm login --registry=https://registry.npmjs.org/` |
| `EPUBLISHCONFLICT` | 同版本已存在 | 升版本号 |
