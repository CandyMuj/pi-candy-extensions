# Claude Code /rewind 调研纪要（供对照审阅）

> 源码来源：`@anthropic-ai/claude-code@1.0.128` 的 `cli.js`（beautify 后逐行分析）+ 本地 `claude-code/` 仓库 CHANGELOG（2.x 演进）。
> 用户安装的 2.1.233 为原生二进制无法直接读源码；核心机制一致，2.x 差异已标注。

## 1. 机制总览

`/rewind` 命令本体仅 5 行：调用 `openMessageSelector()`。真正工作分两部分：

1. **文件级快照系统（file checkpoints）**：hook 文件编辑工具，备份被编辑文件的"编辑前内容"。
2. **消息选择器 UI（AXB 组件）**：列出用户消息，选中后给出恢复选项。

## 2. 跟踪时机（关键设计）

| 函数 | 触发点 | 动作 |
|---|---|---|
| `Pv` (trackEdit) | Edit/Write/MultiEdit/NotebookEdit 工具**执行前** | 最新快照无该文件记录时：备份当前内容为 version 1（新文件记 null），加入 trackedFiles |
| `jy1` (addSnapshot) | 每回合响应结束后，按用户消息 uuid | 遍历 trackedFiles 备份当前内容（未变则复用记录），追加新快照 |
| `xk2`/`bk2` | 选择器确认恢复 | 逐文件绝对恢复（幂等） |

- **首回合缺陷（1.0.128）**：`Pv` 要求"最新快照已存在"，会话第一个回合编辑的文件不会被跟踪（本方案已修复，见 design.md §5）。
- **快照语义偏移**：快照建在回合结束后，实际语义是"消息 N+1 之前"，选择消息 N 时存在 off-by-one（本方案改为回合开始前建快照，语义干净）。

## 3. 存储布局

```
~/.claude/file-history/<sessionId>/<sha256(绝对路径)前16位>@v<N>   ← 内容副本（utf-8 读，二进制有损；保留 mode）
~/.claude/projects/<cwd-slug>/<sessionId>.jsonl                     ← 快照元数据（file-history-snapshot 条目追加，同 messageId 后者覆盖）
```

- 路径规范化：cwd 内转相对、**cwd 外保留绝对路径** → 工作区外文件可回退（本方案同构）。
- 备份不可变：只创建新版本，任何路径都不修改/删除既有备份。
- 元数据在会话 JSONL 中，`appendEntry` 去重分支对 snapshot 类型无条件追加。

## 4. 恢复算法（bk2，幂等）

```
对 trackedFiles 每文件 F：
  目标快照有记录 → 用其备份（null = 删除文件）
  无记录 → 扫描全部快照找 version===1 的记录 = 首次编辑前状态（null = 删除）
  fk2 比较（exists/mode/size/mtime/内容）不同才写 → 内容已一致则跳过（幂等关键）
```

## 5. fork/clone/多会话行为（已核实）

- 加载会话统一走 `Qf`：读旧 JSONL → `yy1` 把备份文件**硬链接**（失败降级复制）到新会话目录 + 快照元数据重写进新会话 JSONL → `Sy1` 重建内存态。
- `--fork-session`（新 id）触发迁移；普通 `--resume` 复用旧 id 直接读原目录。
- **交叉回退**：两会话备份独立且不可变，各自 rewind 互不影响；共享的只有工作区文件本身，**先回退者生效、后回退者因 `fk2` 判断内容已一致而跳过（幂等无操作）**。
- 备份文件消亡途径：仅两条——启动时 `ut5()` 按目录 mtime 删除超过 `cleanupPeriodDays`（默认 30 天）的会话目录；`claude project purge` 显式清除。rewind 本身从不删备份（全模块唯一 `unlinkSync` 删的是工作区文件）。

## 6. 门控与提示

- 开关：Statsig `tengu_use_file_checkpoints` + 非交互模式禁用 + 设置 `fileCheckpointingEnabled`（默认 true）+ 环境变量 `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`。
- UI 固定提示："Rewinding does not affect code edits made manually or via bash."
- 2.1.50 起快照数量设 cap（防内存增长）。

## 7. 2.x 演进要点（CHANGELOG）

| 版本 | 变更 |
|---|---|
| 2.0.0 | 引入 /rewind |
| 2.1.108 | **/undo 成为 /rewind 别名** |
| 2.1.141 | 菜单新增 "Summarize up to here" |
| 2.1.191 | 支持从 /clear 之前恢复 |
| 2.1.216 | 不再通过符号链接/硬链接恢复或删除文件，报告跳过数 |

## 8. CC 方案的可借鉴点与缺陷（本方案的取舍依据）

借鉴：
- 工具级跟踪（覆盖 cwd 外）+ 备份不可变 + 恢复只读 + 按会话隔离 + 绝对恢复幂等语义。
- 硬链接迁移 fork 备份、mtime 过期清理、快照 cap、选择器菜单结构。

缺陷（本方案修复）：
- 首回合编辑不可回退（无 baseline）→ 修复：session_start 建 baseline。
- 回合结束快照的映射偏位 → 修复：回合开始前建快照。
- utf-8 读二进制文件有损 → 修复：Buffer 读写。
- 无 redo → 新增：redo-point 快照栈。
- "both" 恢复时两路独立、代码失败仍回退对话（可能半回退）→ 修复：代码失败即终止。
- 快照元数据膨胀会话文件 → 修复：sidecar state.json。
- 无排除配置（靠工具级跟踪天然免疫）→ 保留其思路，另加可选排除做纵深防御。
