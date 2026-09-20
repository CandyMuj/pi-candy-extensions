---
name: make-release
description: 为多插件 monorepo（pi-candy-extensions）发布 release：确定 release-YYYY.MM.DD 标签、生成按「插件→工具」固定顺序的 release notes（每个插件/工具都列出，无更新则标记）、先维护根 CHANGELOG.md 再经用户确认后打 tag 并一并提交推送、用 gh 创建 GitHub Release。当用户要求「发布 release / 打 release tag / 生成 release notes / 更新 changelog」时使用。
disable-model-invocation: true
---

# 发布 release（pi-candy-extensions）

## 顺序与命名约定（长期稳定，不得自行更改）

- **tag 命名**：`release-YYYY.MM.DD`；同日第二次发布用 `release-YYYY.MM.DD-2`；**永远不要**用插件版本号当 tag（各插件版本独立，会撞名且误导）
- **插件顺序** = 根 `README.md`「插件列表」表格顺序（当前：themes → win-notify → toolbox → undo）；新增插件一律**追加到表尾**
- **toolbox 工具顺序** = `pi-candy-toolbox/extensions/index.ts` 的 `TOOLS` 数组顺序（当前：hello → session-title → click-cursor → transcript-jump）；新增工具一律**追加到数组尾**
- 顺序与版本由 `scripts/release-notes.mjs` 每次从仓库文件读取，**不要硬编码**；每次 release 的排版必须与既有顺序一致，便于长期翻阅

## 铁律

1. **打 tag、推送、创建 GitHub Release 都是不可逆动作**：必须先把完整 notes 与 CHANGELOG 变更给用户审阅并获得明确同意后才能执行
2. **版本闸门**：脚本报「有功能改动但版本未升」→ 阻断打 tag，停下向用户确认（改了代码必须配套升版本）
3. 无更新的插件/工具必须照常列出并标「无更新」，不得省略
4. 中途失败（gh 不可用、push 被拒等）→ 停下汇报，不强行重试；若 tag 已推送但 Release 创建失败，用同一 tag 重跑 gh 命令即可，不要新建 tag
5. 不擅自 push；发布获批后**提交（CHANGELOG）、打 tag、推送（main 与 tag）一并执行**

## 流程

### 1. 确定 tag 名

- 默认 `release-<今天日期 YYYY.MM.DD>`；`git tag -l 'release-*'` 检查是否已存在 → 已存在则 `-2`、`-3`…；与用户确认

### 2. 前置检查（任一不过就停下问用户）

- `git status` 工作区干净
- 各插件自测：themes `npm run build:themes`（应无 diff）；win-notify `node --experimental-strip-types tests/tests.ts`；toolbox / undo `npm test` + `npm run typecheck`
- 用 `npm view <包名> versions --registry=https://registry.npmjs.org/` 核对**线上已发布版本 == 本地 package.json 版本**（改了代码没发 npm、或发了没升版本都要先处理；涉及 npm 发布时先走 npm-publish skill 的 preflight）

### 3. 生成机械草案

```bash
node .agents/skills/make-release/scripts/release-notes.mjs --markdown --tag <tag> > /tmp/pi-temp/release-draft.md
```

- 检查顶部是否有「版本闸门告警」→ 有则回到第 2 步处理
- 核对版本总表的「本次版本」与线上/本地一致

### 4. 写成正式 notes

- 以草案的**结构与顺序**为骨架改写：保留标题、版本总表、每个插件/工具小节与「无更新」标记
- **每条变更写成一条无序列表项**（`- ` 开头），一条提交对应一条描述
- **描述要完整适中**：每条写清「做了什么 + 对用户的影响/原因」，1~2 句话；保留可复现的关键词（命令名、配置项、行为差异、限制条件）。**禁止**为了凑短把描述压成标题式短语（只剩「修复点击列精度」这种没有上下文的半句话），**也禁止**照抄提交全文流水账——把提交主题去前缀后，补上影响面与原因
- **每条列表项末尾一律追加提交引用**：`（#<7位短hash>）`，例如 `(#1a411bf)`——文案里不要用反引号包裹哈希，保持 GitHub 上的自动链接习惯
- 多条同主题提交可合并为一条（描述合成一句话），合并时在末尾**并列引用所有相关短 hash**：`(#aaa1111 #bbb2222)`
- 插件级（core/入口/配置）、各工具、仓库公共各节都遵守同一格式；「无更新」保持一行 `无更新。`，不加引用
- 写进 `/tmp/pi-temp/release-notes.md`（首行为 `# <tag>`，其后是正文）

### 5. 维护 CHANGELOG.md（先做，仅改工作区，不提交）

- **CHANGELOG 的正文必须与 release body 完全一致**：两者都取自同一份 `/tmp/pi-temp/release-notes.md` 正文（首行 `# <tag>` 之外的全文），不得改写、增删或重排
- 插入规则：在根 `CHANGELOG.md` 顶部（文件不存在则创建，首行 `# Changelog`）插入：

```markdown
## <tag>（YYYY-MM-DD）

<notes 正文（版本总表 + 各插件/工具无序列表 + 公共节，与 release body 一字不差）>
```

- 完成后 `git diff CHANGELOG.md` 自查：与 notes 正文逐字一致（仅多出 `## <tag>（YYYY-MM-DD）` 小节标题）

### 6. 用户审阅

- 贴出：tag 名、版本总表、完整 notes、CHANGELOG 的 diff；**等用户明确同意**（可用提问工具确认）
- 提醒：获批后推送 `main` 会一并推上去此前所有未推送的提交（如 skill 更新等），在汇报里说明

### 7. 执行发布（用户同意后一次做完，顺序固定）

```bash
# ① 先提交 CHANGELOG（标题遵循仓库约定：gitmoji + type，主体为发布版本）
git add CHANGELOG.md
git commit -m "🔖 chore: 发布版本 <tag>"

# ② 再打 tag（tag 指向包含 CHANGELOG 的发布提交）
git tag -a <tag> -m "<tag>"

# ③ 一并推送（先分支提交，后 tag）
git push origin main
git push origin <tag>

# ④ 创建 GitHub Release
gh release create <tag> --title "<tag>" --notes-file /tmp/pi-temp/release-notes.md
```

- 顺序理由：**CHANGELOG 先提交、tag 打在其上**，tag 指向的提交就是完整发布内容；提交与 tag 一并推送，不存在「先推送后维护 CHANGELOG」的倒置
- Release 创建失败而 tag 已推送时：用同一 tag 重跑 gh 命令即可

### 8. 汇报

- 版本总表、tag、GitHub Release URL（gh 输出）、CHANGELOG 提交 hash 与推送状态

## 脚本

```bash
node .agents/skills/make-release/scripts/release-notes.mjs                                # JSON 全量数据
node .agents/skills/make-release/scripts/release-notes.mjs --markdown --tag <tag>          # Markdown 草案
node .agents/skills/make-release/scripts/release-notes.mjs <prev> <new> --markdown --tag <tag>  # 指定区间（自测用）
```

- **只读**：不改文件、不打 tag、不建 Release
- prev 缺省 = 最近一个 `release-*` tag；没有则从首个提交起算（标「首个 release」）
- 插件顺序/工具顺序/版本号全部从仓库文件读取；提交按文件路径映射到工具；输出含版本闸门告警
