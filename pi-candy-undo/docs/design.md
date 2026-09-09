# pi-candy-undo 设计文档

> 方案对标 Claude Code 的 `/rewind`（"文件级快照 + 消息选择器"），针对 pi 的扩展 API 落地，并做针对性增强。
> 状态：**已实施**（v1.0.0，含 82 项自动化测试）。

---

## 1. 目标与范围

在 pi 中实现 `/undo`、`/redo` 两个命令：

- `/undo`：弹出消息选择器（CC 风格），选中某条用户消息后按菜单回退：
  - 对话（通过 pi 原生 `navigateTree` 分叉/回退到该消息之前）
  - 代码（把 agent 改过的文件恢复为该消息时刻的内容）
- `/redo`：撤销最近一次 `/undo`。

**范围边界（与 CC 一致）**：

- 只跟踪 agent 通过文件编辑工具改过的文件 → 手动改的、`bash` 改的文件天然不受影响（UI 提示与 CC 相同："Rewinding does not affect files edited manually or via bash"）。
- 文件恢复是"**绝对恢复**"（把文件设为目标快照内容），幂等：已处于目标状态时跳过写入（CC `fk2` 语义）。
- 支持恢复 **cwd 之外** 的文件（CC 特性，工具级跟踪天然支持）。

**非目标（v1 不做）**：`/checkpoint`、Esc-Esc 快捷键、自定义 TUI 组件选择器（先用 `ctx.ui.select` 两段式）、对话注入的 agent 自调用 undo。

---

## 2. 方案选型：对比 git 快照方案（pi-workspace-history 路线）

| 维度 | pi-workspace-history（shadow git） | CC 文件级快照（本方案） |
|---|---|---|
| 跟踪粒度 | 每回合扫描整个 cwd 做 git 快照 | hook `tool_call`，仅备份被编辑文件 |
| 覆盖范围 | 仅 cwd | **cwd 内外皆可** |
| 与用户 git 隔离 | 影子 bare 仓库（复杂：锁、损坏恢复、排除同步） | 纯文件副本，无 git 依赖 |
| 脏检查 | 必须（否则覆盖用户手动改动） | **不需要**（只动 agent 改过的文件） |
| 性能 | 大仓库 `git add -A` 每回合开销 | 每编辑 O(文件大小) 一次备份 |
| 稳定性风险 | 高（git 内部状态、index.lock、Windows 锁） | 低（`readFile`/`writeFile`/`rename`） |

**决策：采用 CC 式工具级文件快照。** 备份不可变（只增不改不删）、恢复只读、按会话隔离——这三点结构性保证来自对 CC 源码的分析（`iV0`/`Xo4`/`bk2`/`fk2`）。

### 2.1 为什么独立实现 /undo，而不是改造内置 /tree

> 结论：独立实现。该结论与 pi-workspace-history 是否占用钩子无关（回退插件通常只装一个），理由如下：

1. **内置 /tree 的 UI 无法定制**：pi 没有任何 API 修改树选择器（↑↓ 折叠/过滤、全树展示）或内置的 "Summarize branch?" 三选一弹窗。扩展唯一入口是 `session_before_tree`（只能取消/提供摘要）——只能"在导航前插入自己的弹窗"，不能修改 /tree 的菜单项。CC 式选择器（用户消息平铺列表 + 每条 diff 统计 + 6 项操作菜单）在 /tree 上不可能实现，必须自建选择器——而这正是独立命令的核心。
2. **/undo 无法干净地别名到 /tree**：pi 没有公开 API 让扩展打开内置树选择器（`navigateTree` 是纯编程接口，不弹 UI）。要么自建选择器（=独立方案），要么退化为"不选择、直接回退上一回合"（pi-workspace-history 的 /undo 正是这种退化形态：无选择器、自动定位上一回合），丢失 CC 选择器体验。
3. **恢复的显式性（CC 核心语义）**：CC 中只有 /rewind 会动文件，对话树导航绝无文件副作用。hook `session_before_tree` 给所有树导航附加文件恢复，会让普通分支切换也被打扰（pi-workspace-history 即如此：每次 /tree 都要先选"是否恢复工作区"），不符合"以 CC 设计为主"。
4. **控制流简单 = 可靠**：独立命令全程在 handler 内串行（选择 → dry-run → 菜单 → 恢复 → 导航 → redo 入栈），不依赖跨扩展事件协作、不受其他扩展 handler 返回值影响。

代价（已评估）：文件恢复与对话导航是两个连续步骤、非原子整体——恢复成功后若 `navigateTree` 被取消（如用户中止摘要），会出现"文件已回退、对话未回退"。缓解：恢复前必建 redo-point 快照（可 /redo 或重试），且正常路径下无第三方扩展取消导航。

v2 可选：若需"内置 /tree 导航时也顺带恢复文件"，加配置 `treeRestore: "ask" | "off"` 走 `session_before_tree` 实现，v1 不做。

---

## 3. 核心数据模型

```ts
// 备份记录：某文件在某个时刻的状态
interface FileBackupRecord {
  backupFileName: string | null;  // null = 该时刻文件不存在（恢复 = 删除）
  version: number;
  backupTime: string;             // ISO
}

// 快照：一次操作（一个用户回合）开始前，所有被跟踪文件的集合状态
interface Snapshot {
  id: string;                     // 稳定内部 id（uuid），不随绑定变化
  key: string;                    // 绑定目标：用户消息 entryId；未绑定时为 opId(uuid)
  files: Record<path, FileBackupRecord>;  // path 规范：cwd 内相对、cwd 外绝对（同 CC hk2）
  createdAt: string;
  kind: "operation" | "baseline" | "redo-point";
}

// 持久化状态（state.json）
interface UndoState {
  version: 1;
  sessionId: string;
  snapshots: Snapshot[];          // 按创建顺序，cap 见 §8
  originals: Record<path, FileBackupRecord>;  // 每文件"首次被 agent 编辑前"的状态（CC v1 语义）
  trackedFiles: string[];         // 所有被跟踪文件的规范路径
  redo: RedoItem[];                // redo 栈（随 state.json 持久化，无独立文件，见 §6）
}

interface RedoItem {
  type: "code" | "conversation" | "both";
  restoreKey: string | null;      // type=code/both：redo-point 快照 key
  oldLeafId: string | null;       // type=conversation/both：undo 前的 leaf
  createdAt: string;
}
```

**恢复算法（等价 CC `bk2` + `Fo4`）**——恢复到快照 S：

```
对 trackedFiles 中每个文件 F：
  S.files[F] 存在 → 用该备份（backupFileName=null 则删除 F）
  S.files[F] 不存在 → 用 originals[F]（首次编辑前状态；null 则删除 F）
  写入前做 fk2 等价比较（exists/mode/size/mtime/内容），已一致则跳过（幂等）
```

**快照时机：回合开始前**（CC 在回合结束后建快照，存在两个问题：快照语义是"消息 N+1 之前"，选择消息 N 时实际恢复的是 N 回合后状态，有 off-by-one；且首回合编辑无快照可依附、无法捕获）。本方案在**操作开始前**（`before_agent_start`）建快照，语义干净：**选择消息 M = 恢复到消息 M 的回合开始之前**。首回合有 baseline 兜底。

**undo 的粒度是"目标时刻"，不是"单个回合"（重要推论）**：选中消息 M = 其后**所有**回合对被跟踪文件的改动一次性全部撤销。例如回合 1 改了 F、回合 2 又改 F 并新建 H，选择消息 1 → F 恢复到回合 1 之前（两回合改动一起消失）、H 被删除。不存在"只抽走中间某个回合的改动"的能力（CC 同样没有，快照式回退的固有语义）；想只撤销最近回合 → 选最近的消息；想逐回合回退 → 依次选越来越早的消息。对话侧同步：navigateTree 同样一次性回退到该消息之前。选择器 dry-run 会展示聚合后的改动总量，确认前可见范围。

---

## 4. 存储布局

```
~/.pi/file-history/                    ← storageDir，默认（Windows/Linux/macOS 统一，path 库处理）
  <sessionId>/                         ← ctx.sessionManager.getSessionId()（会话文件头部 uuid，跨 resume 稳定）
    state.json                         ← UndoState（原子写：临时文件 + rename；500ms 防抖 + session_shutdown 落盘）
    backups/
      <sha256(文件绝对路径) 前16位>@v<N>  ← 不可变内容副本（Buffer 二进制安全，优于 CC 的 utf-8；保留 mode）
  undo.log                             ← 调试日志（配置 `log: true` 时记录）
```

- 与 CC 同构（CC：`~/.claude/file-history/<sessionId>/<hash>@vN`），但元数据用 **sidecar state.json** 而非写进会话 JSONL。
- **为什么不用 `pi.appendEntry()` 写会话文件**：pi 支持该能力（custom entry，不进 LLM 上下文），但：(a) 每次编辑追加一条会让会话文件膨胀、拖慢每次加载的条目重放；(b) JSONL 无"更新"语义，只能同 messageId 后者覆盖（CC 的做法），重放逻辑复杂；(c) fork/克隆迁移时 sidecar + 备份目录一次性拷贝更可控。**决策：全部插件状态进 sidecar。**
- 备份文件名基于**绝对路径哈希** → 同一文件跨会话/跨 fork 基名不变，硬链接迁移安全（CC `Jo4` 同款）。

### 会话迁移（fork / clone / resume）

CC 的 `yy1` 等价物。`session_start` 事件带 `reason` 与 `previousSessionFile`：

| reason | 行为 |
|---|---|
| `startup` / `reload` | 读本会话 state.json（按 sessionId） |
| `resume` | sessionId 不变 → 直接读 |
| `fork`（/fork、/clone 都走这里） | 新会话新 sessionId：读 previousSessionFile 头部 uuid → **复制其 state.json + 硬链接 backups/**（失败降级为复制，CC 同款）；**不迁移 redo 栈**（引用的 entryId 属于旧会话）。仅当旧会话 cwd 与当前 cwd 一致时才迁移（存储路径是 cwd 相对，跨目录会解析错位） |

迁移后新会话自包含，与旧会话互相独立（备份不可变 → 硬链接零风险；交叉回退互不干扰，见 §9）。

---

## 5. 事件流程（跟踪侧）

| pi 事件 | 动作 | 对应 CC |
|---|---|---|
| `session_start` | 加载/迁移 state.json；建 baseline 快照；触发过期清理（防抖） | 状态重放 |
| `tool_call`（`edit`/`write`，**执行前**） | ① 解析路径：`path.resolve(ctx.cwd, input.path)`，剥前导 `@`，已存在则 `realpath`；② 命中排除规则 → 不跟踪；③ 文件未跟踪 → 备份当前内容为 originals[F]（不存在则 null，版本 1），加入 trackedFiles | `Pv` (trackEdit) |
| `input` | 记录 `pendingPromptText`（slash 命令 / `source==="extension"` / `streamingBehavior` 非空 → 不启动新操作） | — |
| `before_agent_start` | 无 pending 操作且非 slash → **建操作快照**：遍历 trackedFiles 备份当前内容（未变则复用旧备份记录，CC `jy1` 同款），kind="operation"，先以 opId 占位；记录 `pendingOperationStartLeafId` | `jy1` 前移 |
| `turn_end` / `agent_settled` | 扫描 branch 中 `pendingOperationStartLeafId` 之后的首条用户消息 → 把占位快照绑定到该 entryId；清 pending | — |
| `input`（新一轮真实 prompt） | **清空 redo 栈** | — |
| `session_shutdown` | 落盘 state.json | — |

要点：

- **首回合可回退**：session_start 建 baseline 快照（kind="baseline"，空 files），修掉 CC 1.0.128 的"首回合编辑不可回退"缺陷。
- 同一文件同回合多次编辑只备份一次（originals 只写一次）。
- `edit` 工具旧参数形态（`oldText/newText`）不影响：只读 `input.path`。
- 并行工具调用同文件竞争：极小概率窗口（pi 内置 per-file 变更队列串行化实际写入），v1 接受，已知限制。
- 文件大小超 `maxFileSizeMB`（默认 100）→ 跳过跟踪并一次性提示（CC 无此保护）。

---

## 6. 命令流程

### /undo

```
1. await ctx.waitForIdle()
2. 门控检查（enabled、ctx.hasUI、storage 可用）→ 不满足则 notify 后返回
3. 构建消息列表：branch 上 role==="user" 的条目（倒序，最新在前），
   每条带 diff 摘要（对该消息快照做 dry-run 恢复统计：文件数/+行/-行；快照缺失 → 最近更早快照）
4. ctx.ui.select("Rewind to before…", 选项)  → 取消则无事发生
5. 计算目标快照 S_M；dry-run 得出改动统计
6. 菜单（与 CC 一致；文案走 i18n，`language` 配置见 §7，上列为 en 文案）：
     有文件改动：  1. Restore code and conversation  2. Restore conversation
                   3. Restore code  4. Summarize  5. Summarize with custom prompt  6. Never mind
     无文件改动：  1. Restore conversation  2. Summarize  3. Summarize with custom prompt  4. Never mind
7. 执行：
   - code（或 both）：先建 redo-point 快照（当前 trackedFiles 状态，用于 /redo）
     → 恢复文件到 S_M（逐文件 fk2 比较 + Windows 锁重试 3 次）
     → 恢复失败：notify 错误并**终止**（不继续导航，保证无半回退状态）
   - conversation（或 both）：ctx.navigateTree(userEntryId, {summarize:false})
     （pi 原生语义：leaf 移到该消息父节点 + 原 prompt 回填编辑器，等价 CC fork 行为）
   - Summarize：navigateTree(userEntryId, {summarize:true})（pi 对离开的分支生成摘要）
   - Summarize with custom prompt：ctx.ui.input(...) → navigateTree({summarize:true, customInstructions})
   - Never mind：直接关闭
8. 推入 redo 栈（code/both → {restoreKey, oldLeafId}；conversation → {oldLeafId}）；超出 `maxRedoStackSize` 丢弃最旧项
9. notify 结果（恢复 N 个文件 / 对话已回退 / 幂等提示"文件已是目标状态，未做改动"）
10. UI 附注（同 CC，i18n 文案）："Rewinding does not affect files edited manually or via bash"
```

**navigateTree 的总结选项不会二次弹窗**（已核实源码：`/tree` 命令 UI 负责弹"Summarize branch?"三选一，`ctx.navigateTree({summarize})` 编程调用直接执行）——因此我们自己的菜单可以完整控制 6 个选项，无重复交互。

### /redo

```
1. await ctx.waitForIdle()
2. peek redo 栈顶；空 → notify "Nothing to redo"
3. 校验：oldLeafId 指向的条目仍存在（getEntry），restoreKey 快照仍存在；失效 → 丢弃该条目并 notify
4. type=code/both：恢复文件到 restoreKey 快照（幂等）
5. type=conversation/both：ctx.navigateTree(oldLeafId, {summarize:false})
6. pop 栈；notify 结果
```

### redo 栈实现（存储策略）

- **存储位置**：`state.json` 的 `redo` 字段（`UndoState.redo`），**无独立文件**，随状态防抖落盘 + `session_shutdown` 强制落盘（原子写）。
- **入栈**：/undo 成功后 push（code/both → `{restoreKey, oldLeafId}`；conversation → `{oldLeafId}`）。
- **出栈**：/redo 成功后 pop。
- **清空**：新操作开始（真实用户 prompt）清空整个栈；**fork/克隆不迁移**（引用的 entryId 属于旧会话），新会话空栈。
- **容量**：`maxRedoStackSize`（默认 50），超出丢弃最旧项。
- **防失效**：快照 cap 淘汰最旧快照时**跳过 redo 栈引用的 redo-point 快照**（否则 /redo 会因 restoreKey 消失而失效，见 §8）。
- **执行前校验**：oldLeafId 对应条目仍存在（`getEntry`）、restoreKey 快照仍存在；失效 → 丢弃该 redo 项并 notify。

### 冲突规避规则

- **新操作开始（真实用户 prompt）→ 清空 redo 栈**。
- **undo 是只读操作**：不删除任何快照/备份 → undo→redo→再 undo 可自由往返。
- redo 是绝对恢复 + 幂等 → 重复执行安全；多个会话（fork 后）交叉回退互不干扰，**哪个会话先回退谁生效，后回退者因内容已一致而跳过（幂等无操作）**，与 CC 实测行为一致。

---

## 7. 配置项（settings.json）

**配置来源与合并规则**：全局 `~/.pi/agent/settings.json`（等价 `getAgentDir()/settings.json`）+ 项目 `.pi/settings.json`（等价 `<cwd>/<CONFIG_DIR_NAME>/settings.json`）（深合并，项目覆盖全局；**项目设置仅在项目被信任时读取**，见 `ctx.isProjectTrusted()`）。读取时机：`session_start`，本会话内不热更新。匹配引擎：`minimatch`（声明为插件依赖）。**唯一配置入口为 settings.json，不接受任何环境变量配置。**

**完整配置示例（全部字段 + 默认值）**：

```json
{
  "candyUndo": {
    "enabled": true,
    "language": "zh",
    "storageDir": "~/.pi/file-history",
    "exclude": [],
    "excludeDefaults": true,
    "trackedTools": ["write", "edit"],
    "maxFileSizeMB": 100,
    "maxSnapshotsPerSession": 200,
    "maxRedoStackSize": 50,
    "cleanupPeriodDays": 30,
    "pickerLimit": 100,
    "log": false
  }
}
```

**逐字段说明**：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 总开关。`true` 启用跟踪与命令；`false` 完全禁用。非交互模式（print/json）下不跟踪（对齐 CC）；`/undo`、`/redo` 仅在 `ctx.hasUI` 时可用 |
| `language` | `"zh" \| "en"` | `"zh"` | 界面语言（菜单、提示、附注）。暂支持中英两种，后续可扩展 |
| `storageDir` | `string` | `"~/.pi/file-history"` | 存储根目录（支持 `~` 展开，Windows/macOS/Linux 由 `path` 库处理）。**必须位于 workspace 外**，否则禁用并提示；其自身内容硬排除（防自备份循环） |
| `exclude` | `string[]` | `[]` | 用户排除 glob 列表（gitignore 风格，`minimatch` 匹配，支持 `!` 否定）。与默认值取并集（见 `excludeDefaults`）；命中即不跟踪、不备份、不恢复。语义见下节 |
| `excludeDefaults` | `boolean` | `true` | 是否并入内置默认排除值。`true` = 默认值 + 用户 `exclude` 取并集；`false` = 完全由用户 `exclude` 接管（内置默认值全部失效） |
| `trackedTools` | `string[]` | `["write", "edit"]` | 跟踪哪些工具的写入调用。可扩展：pi 新增文件工具或自定义工具名直接加进去 |
| `maxFileSizeMB` | `number` | `100`（MB） | 单文件大小上限，超过则跳过跟踪并一次性提示（CC 无此保护）。`0` = 不限制 |
| `maxSnapshotsPerSession` | `number` | `200` | 每会话快照数量上限，超出丢弃最旧快照（回退到极早消息时由 originals 兜底，见 §8）。最小 `1` |
| `maxRedoStackSize` | `number` | `50` | redo 栈容量上限，超出丢弃最旧项 |
| `cleanupPeriodDays` | `number` | `30` | 过期会话目录清理天数（按目录 mtime，见 §8）。`0` = 禁用自动清理 |
| `pickerLimit` | `number` | `100` | `/undo` 消息列表最多展示的条数（最新 N 条），同时限制 dry-run 统计的计算量 |
| `treeRestore` | `"ask" \| "off"` | （v2 预留） | 内置 /tree 导航时是否顺带询问恢复文件，走 `session_before_tree` 实现（见 §2.1，v1 不做） |
| `log` | `boolean` | `false` | 调试日志开关。开启时写入 `<storageDir>/undo.log`，默认关闭 |

### 排除匹配语义

- **内置默认排除值**（`excludeDefaults: true` 时生效）：`.git/**`、`node_modules/**`、`dist/**`、`build/**`、`**/.env*`、`*.lock`、`coverage/**`。可扩展、可整体关闭（`excludeDefaults: false`）、可用 `!` 逐条重新包含。
- **匹配顺序**：最终列表 = （默认值）+（用户 `exclude`），按顺序匹配，后写覆盖先写（minimatch 的 `!` 否定语义）。
- **匹配目标**：cwd 内文件匹配"相对 cwd 路径"；cwd 外文件匹配"绝对路径"（含盘符，Windows 大小写不敏感）；两条都试，命中任一即排除。
- **例外**：`storageDir` 自身及其内容无条件硬排除（不参与匹配，防自备份循环）。

**与 CC 的差异**：CC 无排除配置（靠"只有编辑工具被跟踪"天然免疫）。本插件保留排除作为**纵深防御**（防 agent 误写 `.git/config`、巨型生成物等被快照），默认值最小化、可扩展。

---

## 8. 清理策略（对标 CC 的 `ut5` + 快照 cap）

CC 做法（已从源码核实）：启动时 `setImmediate` 扫描 `~/.claude/file-history/`，删除 **mtime 超过 cleanupPeriodDays（默认 30 天）** 的会话目录；另有 `claude project purge` 显式清除；2.1.50 起对快照数量设 cap 防内存增长。

本方案：

1. **过期会话目录**：`session_start`（每次启动，防抖 60s）扫描 `<storageDir>/*`，mtime 超 `cleanupPeriodDays`（默认 30，`0` 禁用）→ `rm -rf`。
2. **快照 cap**：`maxSnapshotsPerSession`（默认 200）。超出时丢弃最旧快照（baseline 永不清除；operation 与 redo-point 均可被淘汰，但 redo 栈引用的快照受保护）。旧快照被淘汰后，回退到极早消息 = 恢复首次编辑前状态（originals 兜底），降级可接受。
3. **备份文件引用计数 GC**：state.json 写入时，删除 `backups/` 中不被任何保留快照 + originals 引用的备份文件。
4. **originals 永不 GC**（任何回退的最终兜底，每文件仅一份）。

---

## 9. 可靠性与安全

| 事项 | 措施 |
|---|---|
| 原子性 | 备份/state.json 均"临时文件 + rename"；恢复逐文件进行，失败终止并 notify（列出失败文件） |
| 幂等 | fk2 等价比较（exists/mode/size/mtime/内容 Buffer 级），已一致跳过，重复 undo/redo 无副作用 |
| Windows 文件锁 | 恢复失败重试 3 次（100/250/500ms），仍失败 → 终止并提示占用程序 |
| 符号链接 | 跟踪与恢复均对 symlink 路径跳过（计数提示），采纳 CC 2.1.216 的修复 |
| 二进制文件 | Buffer 读写（优于 CC 的 utf-8），保留 mode |
| 崩溃恢复 | state.json 原子写 + session_shutdown 强制落盘；备份文件天然幂等（同内容同路径重写无害） |
| 超大文件 | 超过 maxFileSizeMB（默认 100）跳过跟踪 |
| 会话缺失 | `pi --no-session`（无持久化）→ 正常跟踪但 state.json 按 sessionId 落盘，由过期清理回收 |
| 与 /tree、/fork 共存 | v1 不 hook `session_before_tree`（见 §2.1：恢复保持显式、不改变内置 /tree 行为）；undo 的对话回退完全走内置 navigateTree |

---

## 10. pi 集成点清单（已逐一核实 API 存在）

| 用途 | API |
|---|---|
| 编辑前备份 | `pi.on("tool_call")`，`isToolCallEventType("edit"|"write", event)`，`event.input.path`（执行前触发，可 await） |
| 操作开始快照 | `pi.on("before_agent_start")`、`pi.on("input")`（`event.prompt/text`、`event.streamingBehavior`、`event.source`） |
| 绑定用户消息 | `pi.on("turn_end")` / `pi.on("agent_settled")` + `ctx.sessionManager.getBranch()/getLeafId()/getEntry()` |
| 会话生命周期 | `pi.on("session_start")`（`event.reason`、`event.previousSessionFile`）、`pi.on("session_shutdown")` |
| 命令 | `pi.registerCommand("undo"|"redo", { handler })`；`ctx.waitForIdle()` |
| 选择器 UI | `ctx.ui.select(title, string[])`（两段式：消息列表 → 操作菜单）、`ctx.ui.input`、`ctx.ui.notify` |
| 对话回退 | `ctx.navigateTree(userEntryId, {summarize, customInstructions})`（编程调用不弹二次确认，已核实源码） |
| 会话 id / 文件 | `ctx.sessionManager.getSessionId()`、`getSessionFile()`、`getEntries()` |
| 设置读取 | 直接读 `~/.pi/agent/settings.json`（`getAgentDir()/settings.json`）+ `.pi/settings.json`（`<cwd>/<CONFIG_DIR_NAME>/settings.json`）（扩展无 settingsManager；用官方导出避免硬编码路径；项目设置受 `ctx.isProjectTrusted()` 门控） |
| 路径/文件 | `node:fs/promises`、`node:path`、`node:crypto`、`node:os`（homedir 处理 `~`，Windows 兼容） |
| 依赖 | `minimatch`（排除匹配）、`diff`（恢复预览的 +/− 行统计）（插件 package.json dependencies；pi 包安装走 production install） |

**命令名**：`/undo`、`/redo`（pi 命令名不支持空格/别名，与既有约定一致）。

---

## 11. 与 CC 的已知差异（有意为之）

1. **快照时机**：CC 为回合结束快照（存在首回合不可回退窗口、消息映射偏一位）；本方案为回合开始快照 + baseline，语义更直观。
2. **redo**：CC 无 redo；本方案用 redo-point 快照栈实现（undo 前先快照当前状态）。
3. **失败处理**：CC 对 "both" 两路独立尝试（代码失败仍回退对话）；本方案代码失败即终止（避免半回退），更保守。
4. **元数据位置**：CC 写会话 JSONL；本方案 sidecar state.json（理由见 §4）。
5. **二进制/符号链接/超大文件/排除配置**：CC 无或后补（2.1.216 symlink）；本方案 v1 内置。
6. **"Summarize" 语义**：CC 2.1.141 的"Summarize up to here"压缩选中点之前的上下文；pi 的 navigateTree 摘要对象是"被离开的分支"。菜单选项映射到 pi 语义（对离开的分支做摘要），更符合 pi 原生模型。

---

## 12. 实施计划与结果

### 12.1 计划（原方案）

1. 骨架：`pi-candy-undo/` 包结构（`extensions/index.ts` + package.json + 类型）
2. 存储层：路径/配置加载/排除匹配/state.json 读写/备份文件 CRUD
3. 跟踪层：tool_call hook + before_agent_start 快照 + turn_end 绑定 + fork 迁移
4. 恢复层：fk2 等价比较 + 恢复执行 + Windows 重试 + 符号链接防护
5. 命令层：/undo 两段式菜单 + /redo + 幂等提示 + redo 栈规则
6. 清理层：过期目录 GC + 快照 cap + 备份引用计数
7. 测试：单元（幂等/排除/迁移）+ 手工场景（首回合、cwd 外文件、fork 交叉回退、undo/redo 往返）

### 12.2 实施结果

代码结构（2635 行源码 + 1784 行测试）：

```
pi-candy-undo/
  extensions/index.ts    # pi 接线（7 个事件 + /undo + /redo + ctx 适配）
  src/
    types.ts    config.ts   paths.ts   exclude.ts   i18n.ts   log.ts
    storage.ts  state.ts    tracker.ts restore.ts    session.ts commands.ts
  tests/         # node --test，82 项用例（真实文件系统 + 桩 pi API）
```

分层：存储层（paths/config/exclude/storage/state）→ 跟踪层（tracker/session）→ 恢复层（restore）→ 命令层（commands）→ 入口接线（extensions/index.ts）。所有 `src/` 模块不依赖 pi 运行时（只用 `import type`），因此可用 `node --test` 直接测试；入口层用桩 `ExtensionAPI` 做集成测试。

验证：

| 项 | 结果 |
|---|---|
| `npm test` | 82/82 通过，连续 5 轮无 flaky |
| `npm run typecheck` | 通过（strict + noUnusedLocals + erasableSyntaxOnly） |
| pi 官方 jiti 加载器 | 加载成功，注册 7 事件 + 2 命令 |
| `pi -e ./pi-candy-undo --help` | 真实 pi 加载无错误 |
| RPC 真实会话 | session_start 建 storage/baseline；`/undo` → "Nothing to undo"；`/redo` → "Nothing to redo"；无扩展错误 |

测试中发现并修复的缺陷：

1. `bindOperation` 的 pending id 与 `snapshot.key` 混用，导致快照绑定永不生效（已加回归测试）。
2. 跟踪期 mtime 快捷判断误用 `<=`，同毫秒内改写会被误判为“未修改”（CC 用严格 `<`）；已修正并加同时间戳回归测试。

与计划的差异：`Snapshot` 增加稳定 `id`；依赖增加 `diff`（恢复预览行统计）；项目设置读取增加 `ctx.isProjectTrusted()` 门控；fork 迁移增加 cwd 一致性守卫；快照 cap 同时淘汰 operation 与 redo-point（baseline 永久保留）。

---

## 13. 决策记录（已确认）

1. `exclude` 默认值清单（`.git/** node_modules/** dist/** build/** **/.env* *.lock coverage/**`）→ **已确认：合理，采用**。
2. `maxFileSizeMB` 默认 100、`maxSnapshotsPerSession` 默认 200 → **已确认：合理，采用**。
3. "代码恢复失败即终止整个 undo"（与 CC 的"两路独立"不同，更保守）→ **已确认：同意，采用**。
4. 菜单文案语言 → **已确认：加入 i18n**，新增配置 `language`（暂支持 `"zh"` / `"en"`），所有用户可见文案（菜单、提示、附注）走语言包（见 §7）。
5. 新增配置项 `excludeDefaults`（默认 true，可完全接管默认排除）、`maxRedoStackSize`（默认 50）、`pickerLimit`（默认 100）→ **已确认：接受，采用**。
