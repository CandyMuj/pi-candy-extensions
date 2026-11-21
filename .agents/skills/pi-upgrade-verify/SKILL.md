---
name: pi-upgrade-verify
description: 升级 pi 版本后对全仓插件做回归验证的固定流程——动态发现所有插件、把 devDependencies 中的 pi 核心包升级到新版本、运行每个插件的全部测试/类型检查/构建脚本并做加载冒烟、检查 TUI 内部机制依赖、同步根 README 验证版本。当用户说「升级了 pi」「验证新版本」「全仓回归」「重新验证插件」时使用。插件与测试命令全部从仓库动态发现，新增插件无需修改本 skill。
disable-model-invocation: true
---

# 升级 pi 后全仓验证

## 原则（零维护：一切从仓库动态发现，不硬编码任何插件名/工具名）

- **插件清单** = 仓库根目录下「含 `package.json` 且含 `pi` manifest」的子目录（排除 `.agents` / `.pi` / `node_modules`）
- **自测命令** = 各插件 `package.json` 的 `scripts` 动态读取，命中即跑
- 新增/删除/改名插件都不需要维护本 skill

## 流程

### 1. 确定目标版本

```bash
pi --version                       # 用户刚升级到的版本，如 1.5.2
npm view @earendil-works/pi-tui version --registry=https://registry.npmjs.org/
```

pi CLI 与 `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` 版本 lockstep 发布，以 `pi --version` 为准。

### 2. 升级各插件的 pi 核心 devDependencies

- 对每个插件的 `package.json`：`devDependencies`（以及误放的 `dependencies`/`peerDependencies` 中的非 `*` 版本）里所有 `@earendil-works/pi-*` 条目 → 改为 `^<新版本>`
- 用 edit 工具逐文件修改；该插件目录下 `npm install` 同步 lockfile（themes 无 lockfile 可跳过安装）

### 3. 逐插件验证（全部命中项都跑，任何一项失败即停下修，不得带病过）

按顺序对每个插件执行：

1. **scripts 全量执行**：`package.json` 的 `scripts` 中所有名字匹配 `/^(test|typecheck|build|check)/` 的脚本依次运行
2. **无 test 脚本但有 `tests/` 目录**：`node --test "tests/**/*.ts"`（node ≥ 23 默认剥离 TS 类型，无需参数）
3. **build 类脚本跑完后**：`git status` 确认仓库内生成物无 diff（生成脚本应确定性产出）
4. **版本一致性**：`npm view <包名> version --registry=https://registry.npmjs.org/` 与本地 `package.json` 的 `version` 比对；不一致 → 停下提示「本地有未发布改动，先处理发布」再继续
5. **加载冒烟**（真实 API 兼容性兜底；每个插件消耗一次极简模型调用）：

   ```bash
   timeout 60 pi -e <插件目录> --mode json -p "ok" < /dev/null 2>&1 | tee /tmp/pi-temp/smoke-<插件名>.log
   ```

   判定标准（**不以退出码为准**）：输出中出现 `"type":"agent_settled"`（会话已跑完，说明扩展在真实 pi 里完成注册 + 最小会话生命周期）且无扩展报错（`ExtensionError`、`Failed to load extension`、插件名报错堆栈等）即通过；超时内无 `agent_settled` 视为失败。

   > 背景：`pi -e` 临时加载插件后进入 TUI，打印模式跑完会话后进程也不主动退出（pi 的既有行为，不是插件问题）；`agent_settled` 就是「流程完整走完」的信号。每次冒烟顺带探测退出行为：若超时前进程自行退出且退出码 0，说明 pi 已恢复自动退出，可恢复「退出码 0 且输出无报错」的判定。
   >
   > `pi -e <目录> --help` / `--version` 会提前短路、**不加载扩展**（实测对不存在的路径也照样 exit 0），不能替代本冒烟。

### 4. 仓级检查

- `.agents/skills/` 下所有 `.mjs` 脚本：`node --check <文件>`
- **TUI 内部机制依赖检测**：grep 各插件 `extensions/` 下 `tui.children` / `currentLayout` / `inputListeners` 等内部字段；命中者提示用户——单测与加载冒烟都不走 TUI 渲染路径，这类依赖需要用户在真实 pi 里做一次交互冒烟（如点一下、触发一次跳转）
- **根 README**：「开发验证版本」行与回退安装命令更新为新版本

### 5. 汇报

汇总表（插件 | 本地版本 | scripts | typecheck | 冒烟 | npm 版本一致性）+ 修复清单 + 需用户真机确认的事项。

## 注意事项

- **类型回归是第一道关**：devDeps 升到新版本后 typecheck 会暴露 API 变化（例如事件类型从单对象变判别联合）；运行时事件字段的语义变化按新类型修正
- 单测大量使用 stub 的插件，真实 API 兼容性由「typecheck + pi -e 冒烟」兜底
- 验证通过前不要发布、不要提交；提交/推送/发布等动作等用户明确指示
- 若加载冒烟需要跳过（省模型调用），先问用户，不要自行省略
