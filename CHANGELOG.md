# Changelog

## release-2026.09.20（2026-09-20）

> 首个 release：自仓库创建（2026-08-27）以来的全部变更，对应 4 个包在 npm 官方源的首次发布。

### 版本总表

| 插件 | 本次版本 | 相对上次 | 状态 |
|---|---|---|---|
| [pi-candy-themes](https://www.npmjs.com/package/pi-candy-themes/v/1.0.0) | 1.0.0 | — | 有变更 |
| [pi-candy-win-notify](https://www.npmjs.com/package/pi-candy-win-notify/v/2.0.0) | 2.0.0 | — | 有变更 |
| [pi-candy-toolbox](https://www.npmjs.com/package/pi-candy-toolbox/v/1.0.0) | 1.0.0 | — | 有变更 |
| [pi-candy-undo](https://www.npmjs.com/package/pi-candy-undo/v/1.0.0) | 1.0.0 | — | 有变更 |

### 各插件变更

#### pi-candy-themes 1.0.0

- 新增 Selenized TUI 主题插件：基于 Jan Warchoł 的 Selenized 调色板提供 black / dark / light / white 四套 TUI 主题，主题文件由 `scripts/generate-themes.mjs` 从调色板数据生成；文档说明图标字形需 Nerd Fonts 并附下载地址 (c201957, 3be22df)

#### pi-candy-win-notify 2.0.0

- 迁移原 pi-win-notify 仓库源码：以原仓库 main 分支 5889e19 提交为基线迁入本 monorepo，作为 pi-candy-win-notify 的起点 (e43fcd9)
- 新增终端标签页四态状态显示：标题随任务状态（等待/运行/成功/失败）实时变化，配合 OSC 9;4 进度语义；并修复加载阶段 getSessionName 报错与 OSC 9;4 进度语义误用 (8cc51b4, 6611fdd, 52f6f28)
- 标题状态显示配置化：新增 `/notify title` 命令、支持按状态分别配置原生/兼容标题；`titleStatus` 新增 both 模式（同时启用两种显示）、默认值统一为 both，并移除终端标题中的「π -」前缀 (d491df5, a082539, 3f4005b, 859a84b, e64abab)
- 本地化与文档：默认语言改为 zh、README 重写为中文并注明来源、补充关闭勿扰的解除方法 (df9a5f3, 46ab49e, 7b1d353)
- 包名、仓库地址等元数据对齐本 monorepo，版本定为 2.0.0（首个正式发布） (8eac5a2)
- 等待状态检测改用官方事件：pi ≥ 0.84.4 用 `ui_prompt_start` / `ui_prompt_end` 精确识别「阻塞等待用户输入」（覆盖 ask / plan / permission 等所有 ctx.ui 提问交互），旧版回退为 waitingTools 工具名匹配；文档补充推荐版本与 waitingTools 配置说明 (84e8306, d502c1b)

#### pi-candy-toolbox 1.0.0

##### 插件级

- 搭建工具聚合插件脚手架：确立「单插件多工具」架构——按 TOOLS 清单注册、每个工具独立开关与配置，hello 示例随脚手架落地；日志统一写文件（`<logDir>/<工具id>.log`，不遮挡 UI），并新增 `$toolbox` 插件级配置（debug / logDir） (3faec52, dbf5162)
- 提取会话 entry 公共工具到 core/entries（isUserMessage / entryText 等），供历史重建等场景复用与测试 (11242c1)

##### hello

- 示例工具默认关闭并修正文档措辞：hello 只作新工具脚手架参考，默认不启用 (77823ff)

##### session-title

- 新增会话标题生成工具：会话结束后按内容自动生成/重新生成标题，可通过 `/candy-title [提示词]` 手动触发，生成期间有进度反馈 (f6ca322, 80637be)
- 配置能力：支持配置专用生成模型（不占主对话模型配额）、`/candy-title config` 子命令、autoFirst 默认开启、maxTokens 与 maxLength 联动防截断 (a8b117d, 07f2a34, a01265b, ba9cb27)
- 健壮性：运行期报错改走 notify（不再遮挡输入框）、配置写入失败提示异常原因、空会话不再调模型编造标题 (e90b325, 3ff724f, 28d865b)

##### click-cursor

- 新增全屏点击定位光标工具：点击输入框任意位置即移动光标，按显示宽度精确映射（中文/emoji 等宽字符点到字符间隙），类似 Claude Code 的点击编辑体验 (edf2c40)
- 点击定位精度修复：列定位按显示宽度逐字符修正、wrap 段起点与内容居中偏移校正，消除多字节字符与长行/换行场景的点击偏差 (9db7d46, a2aa1b5)
- 与拖拽/双击/三击共存（VS Code 式交互）：按下放行、未移动的释放才判定为单击；双击/三击选词选行由 viewport 原生处理并自动复制；补编辑器外按下的 debug 日志 (374c56c, 8c7d32d, b9049b8)
- 日志与测试基建：debug 日志改为写入文件（不遮挡 UI）、新增 node --test 单测（17 用例）与 typecheck 配置、工具列表按添加顺序排列并同步文档 (a46dd02, a038c5d, e33f192)
- /resume 后重建编辑器历史，修复上下键失效：会话重建（reload / resume / fork / new）后按当前会话重建 editor history——pi 的 populateHistory 只追加不清空、换自定义编辑器时不搬运 history（官方 issue #7997/#8798 未修），本工具在 session_start 时幂等重建，保证 ↑↓ 历史切换可用 (0369f72)
- autocomplete 条目点击改由 pi 原生处理：列表行点击放行给原生 Editor.handleMouse（pi ≥ 0.85）选中条目；内容行边界改用 renderedVisibleLineCount（顺带修掉列表打开+文本滚动时点列表行误移光标的隐患）；文档说明本工具计划在官方实现稳定后退役、根 README 增「按功能选 pi 版本」表 (8b644b1, 84f0f25)

##### transcript-jump

- 新增提问跳转工具：`/candy-jump`（快捷键 `alt+j`，仅全屏）打开当前会话提问列表，选中即滚动到对应组件行 (6a8e630)
- 定位完善：默认快捷键改为 alt+j、列表只取当前分支、支持跳转纯 skill 块提问、skill 块内提问统一跳 skill 组件、locatePromptRow 复用 LocateTarget 类型 (1706cd6, adfb14e, eb6fed3, eb1e5c0, 61854c5)
- 自动定位当前提问：选择器打开时预选距当前滚动位置最近的提问（异步执行避免阻塞渲染），成功时记录调试日志 (02f0061, 2607172, 2b44ce0)

#### pi-candy-undo 1.0.0

- 设计与调研：设计文档与 Claude Code `/rewind` 调研纪要、undo 粒度（回退到「目标时刻」的完整状态）、配置项与 redo 栈存储设计（不随 fork/clone 迁移）、界面 i18n 决策 (01b3542, c34f3c6, 49d3ec1, 8f5da7e, 5b248da, 73fa213)
- 新增文件级撤销/重做插件：`/undo`、`/redo` 按用户消息回退对话与 agent 改过的文件（对标 Claude Code `/rewind`），支持 cwd 外文件、redo、快照/硬链接备份、会话隔离与过期清理 (67ea9fe)
- 配置合并语义文档化：字段级深合并、数组整体替换、null 表示未设置 (30ba234)
- 回退体验：回退菜单展示所选消息与相对时间、增加提示图标 (278ccff, 41c74ce)
- 选择器支持搜索与翻页，替换原生 select：长会话下快速定位回退点 (1cc635c)
- 内部维护：移除未使用的预留配置/死代码、统一「明确不做」说明并移除 /tree 集成预留、源码注释统一中文、测试覆盖非法配置告警链路 (bfca719, 5d72ed4, eb25c22, 53ec4a6, 39f5ec2)
- 文档：安装后生效时机与跟踪起点、文件跟踪与回退行为矩阵（含导航）、文件修改工具强制使用说明（须走 edit/write 等内置工具才会被跟踪） (2e7bccc, a4d6882, c72ecf5, bc8b1fb, 25de837)

### 仓库公共

- 仓库基建：.gitignore / .gitattributes（统一 LF 与忽略规则）、根 README（插件列表、按功能选 pi 版本 0.85.1 / 0.84.4、fullscreen 验证环境说明、npm 与本地两种安装方式） (b5e95b9, c5c108a, 51eac99)
- 发布准备：publishConfig 指向 npm 官方源、版本号统一为 1.0.0、发布元数据与 MIT LICENSE 补齐、子目录 .gitignore 合并到根、验证基线升级至 pi 0.85.1 (ae3a1a5, 053f075, 199e3b0, 1ddaa99, 7fce2c3)
- 安装与版本文档：本地安装命令改为 `npm install --omit=dev`（警告不要加 `--omit=optional`）、推荐版本与 waitingTools 配置说明 (75b28ab, 0481819, d502c1b)
- 发布工具链：新增 npm-publish（发布流程 + preflight 检查脚本 + 2FA 探测与浏览器认证步骤）与 make-release（release 流程与 notes 生成脚本）两个 skill，并关闭模型自动触发（仅手动调用） (674059b, 39535d8, 3dcc9b2, 43e17a8)
