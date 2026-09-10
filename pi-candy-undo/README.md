# pi-candy-undo 🍬

pi 的文件级撤销/重做插件，对标 Claude Code 的 `/rewind`：**按用户消息回退对话与 agent 改过的文件**。

```text
/undo   选择一条历史消息 → 恢复代码 / 恢复对话 / 两者 / 摘要后回退
/redo   撤销最近一次 /undo
```

## 特性

- **文件级快照**：只跟踪 agent 通过 `write` / `edit` 改过的文件，手动修改、`bash` 修改的文件天然不受影响
- **支持工作区外文件**：agent 用绝对路径改过的文件同样可回退（工具级跟踪，无 cwd 限制）
- **对话与代码联动**：对话回退走 pi 原生 `navigateTree`（分叉 + 原 prompt 回填编辑器），代码回退独立可选
- **绝对恢复 + 幂等**：恢复是"把文件设为目标时刻的内容"，已处于目标状态时跳过写入；重复 `/undo`、`/redo` 安全
- **redo 支持**：每次 `/undo` 前自动记录当前状态，`/redo` 可原样找回
- **fork / clone 迁移**：新会话自动继承撤销历史（复制元数据 + 硬链接备份）
- **i18n**：菜单与提示支持中文 / 英文

## 使用

### `/undo`

1. 弹出消息列表（最新在前），每条显示该消息时刻的文件改动统计
2. 选中一条消息后选择操作：

| 有文件改动 | 无文件改动 |
|---|---|
| 恢复代码和对话 | 仅恢复对话 |
| 仅恢复对话 | 摘要并回退对话 |
| 仅恢复代码 | 自定义摘要并回退对话 |
| 摘要并回退对话 | 算了 |
| 自定义摘要并回退对话 | |
| 算了 | |

3. 执行后把操作推入 redo 栈

### `/redo`

重做最近一次 `/undo`（文件与/或对话）。以下情况会清空 redo 栈：发送新的用户消息。

## 工作原理

- **跟踪时机**：`tool_call` 事件在工具执行前触发，此时把文件"编辑前内容"存为不可变备份（每个文件首次出现时记录为 `originals`）
- **快照时机**：每个 agent 操作**开始前**（`before_agent_start`）记录所有被跟踪文件的当前状态
- **回退语义**：选择消息 M = 恢复到 M 回合开始之前。注意这是"目标时刻"语义：选中较早的消息会一次性撤销其后**所有**回合的改动（快照式回退的固有行为）
- **恢复算法**：目标快照有记录 → 用该备份（记录为"不存在"则删除文件）；无记录 → 用 `originals`（该文件首次被 agent 编辑前的状态）
- **跳过项**：符号链接、硬链接、超过大小上限的文件不会被跟踪或恢复

## 配置

唯一配置入口是 pi 的 `settings.json`（全局 `~/.pi/agent/settings.json` + 项目 `.pi/settings.json`，**项目配置仅在项目被信任时读取**）。不读取任何环境变量。

两处配置按**字段级深合并**：项目只需写要覆盖的字段，未写字段沿用全局，均为未写时使用内置默认值；**数组整体替换**（不追加、不合并）；`null` 视为未设置。另注意 `exclude` 的两层语义 —— 全局与项目之间是“替换”，而内置默认值与你的 `exclude` 之间是“并集”（由 `excludeDefaults` 控制）。

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

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；非交互模式（`-p` / json）下不跟踪 |
| `language` | `"zh" \| "en"` | `"zh"` | 菜单与提示语言 |
| `storageDir` | string | `"~/.pi/file-history"` | 存储根目录，**必须位于工作区外**，否则禁用 |
| `exclude` | string[] | `[]` | 排除 glob（gitignore 风格，支持 `!` 否定） |
| `excludeDefaults` | boolean | `true` | 是否并入内置默认排除（`.git/**`、`node_modules/**`、`dist/**`、`build/**`、`**/.env*`、`*.lock`、`coverage/**`） |
| `trackedTools` | string[] | `["write","edit"]` | 跟踪哪些工具的写入 |
| `maxFileSizeMB` | number | `100` | 单文件大小上限，`0` = 不限制 |
| `maxSnapshotsPerSession` | number | `200` | 每会话快照上限，超出淘汰最旧（redo 引用的快照受保护） |
| `maxRedoStackSize` | number | `50` | redo 栈容量，`0` = 禁用 redo |
| `cleanupPeriodDays` | number | `30` | 过期会话目录清理天数（按目录 mtime），`0` = 禁用 |
| `pickerLimit` | number | `100` | 消息列表最多显示条数 |
| `log` | boolean | `false` | 写入 `<storageDir>/undo.log` 调试日志 |

排除匹配：cwd 内文件匹配相对路径，cwd 外文件匹配绝对路径；无 `/` 的模式按文件名匹配任意层级。

## 存储布局

```text
~/.pi/file-history/
  <sessionId>/
    state.json                     # 快照元数据 + originals + redo 栈（原子写）
    backups/<sha256(路径)[:16]>@v<N>  # 不可变内容副本（保留文件 mode）
  undo.log
```

- 备份不可变：只新增版本，从不修改或删除既有备份（回退只读）
- 会话隔离：每个会话独立目录；fork/clone 时复制元数据并硬链接备份，redo 栈不迁移
- 清理：启动时删除 mtime 超过 `cleanupPeriodDays` 的会话目录；快照超限时淘汰最旧快照，并回收无引用的备份文件

## 安装

本地目录安装（与仓库其他插件一致）：

```bash
cd pi-candy-extensions
pi install ./pi-candy-undo
```

或在 `settings.json` 中直接声明：

```json
{ "extensions": ["/absolute/path/to/pi-candy-undo/extensions"] }
```

首次安装后需在插件目录执行一次 `npm install`（本地路径安装不会自动装依赖）。

> 若当前已有会话在运行：`pi install` 不会热加载，需执行 `/reload`（或重启 pi）。插件**从加载那一刻开始记录**，加载之前的 agent 改动无法回退。

## 开发

```bash
npm install
npm test          # node --test（77+ 用例，覆盖配置/排除/存储/跟踪/恢复/命令/入口）
npm run typecheck # tsc --noEmit
```

设计文档见 [`docs/design.md`](docs/design.md)，Claude Code `/rewind` 调研纪要见 [`docs/research-cc.md`](docs/research-cc.md)。

## 已知边界

- **从插件加载后开始跟踪**：加载之前 agent 已改过的文件没有历史数据，无法回退（这正是"装完立刻 `/undo` 只能回退对话"的原因）
- 选择"加载之前"的旧消息作为目标时，已跟踪文件会回落到"首次被 agent 编辑前"的内容，即把该文件在此之后的 agent 改动一并回退；选择器会先展示改动范围再确认
- 快照全自动生成，**无需手动打点**（不存在 checkpoint 类命令）
- 只跟踪 `write` / `edit`（可通过 `trackedTools` 扩展）；`bash` 造成的修改无法跟踪
- 二进制文件按字节读写（安全），但 diff 统计按 1 行计
- 符号链接 / 硬链接路径不恢复也不删除（避免越界写入）
- 与工作区 git 完全无关，不产生任何 git 操作
