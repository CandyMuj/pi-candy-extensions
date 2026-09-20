# Changelog

## release-2026.09.20（2026-09-20）

> 首个 release：自仓库创建（2026-08-27）以来的全部变更，对应 4 个包在 npm 官方源的首次发布。

## 版本总表

| 插件 | 本次版本 | 相对上次 | 状态 |
|---|---|---|---|
| [pi-candy-themes](https://www.npmjs.com/package/pi-candy-themes/v/1.0.0) | 1.0.0 | — | 有变更 |
| [pi-candy-win-notify](https://www.npmjs.com/package/pi-candy-win-notify/v/2.0.0) | 2.0.0 | — | 有变更 |
| [pi-candy-toolbox](https://www.npmjs.com/package/pi-candy-toolbox/v/1.0.0) | 1.0.0 | — | 有变更 |
| [pi-candy-undo](https://www.npmjs.com/package/pi-candy-undo/v/1.0.0) | 1.0.0 | — | 有变更 |

## 各插件变更

### pi-candy-themes 1.0.0

- 新增 Selenized TUI 主题插件：基于 Jan Warchoł 的 Selenized 调色板提供 black / dark / light / white 四套 TUI 主题，主题文件由 `scripts/generate-themes.mjs` 从调色板数据生成，可直接 `pi install npm:pi-candy-themes` 使用 (#c201957)
- 文档说明图标需要 Nerd Fonts：主题中使用的图标字形依赖 Nerd Fonts，README 补充说明并给出字体下载地址，避免用户看到乱码 (#3be22df)
- 各包 publishConfig 指向 npm 官方源：本机 npm 默认走 npmmirror 镜像，`publishConfig.registry` 固定发布目标为 registry.npmjs.org，发布不再受本机镜像配置影响 (#ae3a1a5)
- 版本号统一为 1.0.0：themes 从 0.2.0、toolbox 从 0.1.0 升至 1.0.0（undo 已是 1.0.0、win-notify 保持 2.0.0），作为首个正式发布基线 (#053f075)
- 补齐发布元数据与 LICENSE：补 author、repository.directory（monorepo 子目录指向）、peerDependenciesMeta.optional（pi 核心包由宿主提供，npm 不再为纯 npm 用户/开发机自动安装 400MB+ 副本），并随包发布 MIT 许可证正文 (#199e3b0)
- 统一各 README 安装说明：本地安装命令改为 `npm install --omit=dev`（只装运行时依赖，themes/toolbox 无依赖则无需安装），并警告不要加 `--omit=optional`（会跳过 koffi 的 Windows 平台二进制导致安装失败） (#75b28ab)

### pi-candy-win-notify 2.0.0

- 迁移原 pi-win-notify 仓库源码：以原仓库 main 分支 5889e19 提交为基线迁入本 monorepo，作为 pi-candy-win-notify 的起点 (#e43fcd9)
- 新增终端标签页四态状态显示：标题随任务状态（等待/运行/成功/失败）实时变化，配合 OSC 9;4 进度语义，让终端标签页一眼可见任务状态 (#8cc51b4)
- 修复加载阶段 getSessionName 报错：启动早期会话信息尚未就绪时不再抛错，避免加载阶段异常 (#52f6f28)
- 修正 OSC 9;4 进度状态语义：修正进度 0-100 的语义使用，避免状态被误显示为进度 (#6611fdd)
- 支持按状态配置原生/兼容标题显示：不同任务状态（等待/运行/成功/失败）可分别选择原生标题或兼容标题的显示方式，配置更灵活 (#d491df5)
- 新增 `/notify title` 命令：在命令行直接配置标题状态显示方式，无需手改配置文件 (#a082539)
- 移除终端标题中的「π -」前缀：标题更简洁直接，符合多数用户的阅读习惯 (#e64abab)
- titleStatus 支持 both 模式：可同时启用原生与兼容两种标题显示，二者互补 (#3f4005b)
- 语言配置默认值改为 zh：默认使用中文提示，与目标用户一致 (#df9a5f3)
- README 重写为中文并补充来源说明：文档本地化，并注明插件来源与上游实现说明 (#46ab49e)
- 文档补充关闭勿扰的解除方法：误开勿扰后用户可按文档自行恢复通知 (#7b1d353)
- 更新包信息为当前项目并升版至 2.0.0：包名、仓库地址等元数据对齐本 monorepo，版本定为 2.0.0（首个正式发布） (#8eac5a2)
- titleStatus 默认值调整：waiting / done / failed 三态默认均为 both，开箱即用即显示完整的状态信息 (#859a84b)
- 等待状态检测改用官方事件：pi ≥ 0.84.4 使用 `ui_prompt_start` / `ui_prompt_end` 精确识别「阻塞等待用户输入」，覆盖 ask / plan / permission 等所有 ctx.ui 提问交互；旧版 pi 回退为 waitingTools 工具名匹配（对新插件/改名工具可能漏判） (#84e8306)
- 文档补充推荐版本与 waitingTools 配置说明：说明 0.84.4+ 自动走官方事件、旧版的工具名匹配局限以及配置方式 (#d502c1b)
- 子目录 .gitignore 合并到根目录：忽略规则统一到根维护，并解除对 win-notify package-lock.json 的忽略，使其进入版本控制保证依赖可复现 (#1ddaa99)
- 本地安装命令改为只装运行时依赖：`npm install --omit=dev`；README 明确 koffi 的 Windows 原生二进制在 optionalDependencies 中，**不可加 `--omit=optional`**（否则 koffi 回退源码编译、缺 CMake 导致安装失败） (#0481819)

### pi-candy-toolbox 1.0.0

#### 插件级

- 搭建工具聚合插件脚手架：确立「单插件多工具」架构——按 TOOLS 清单注册，每个工具独立开关与配置，hello 作为示例工具随脚手架落地 (#3faec52)
- 日志统一写文件并新增 $toolbox 插件级配置：工具日志不再打印终端（避免遮挡 UI），统一写 `<logDir>/<工具id>.log`；`$toolbox.debug` / `$toolbox.logDir` 提供插件级开关，与各工具 debug 为「或」关系 (#dbf5162)
- 提取会话 entry 公共工具到 core/entries：click-cursor 的历史重建等共用逻辑（isUserMessage / entryText）收敛到 core/entries，便于复用与测试 (#11242c1)
- 验证基线升级至 pi 0.85.1：全部插件在该版本下回归测试（toolbox 92 用例、undo 86、win-notify 57，typecheck 通过），README 开发验证版本同步更新 (#7fce2c3)

#### hello

- 示例工具默认关闭并修正文档措辞：hello 只作新工具脚手架参考，默认不启用，文档措辞不再暗示它是正式功能 (#77823ff)

#### session-title

- 新增会话标题生成工具：agent 会话结束后按会话内容自动生成/重新生成标题，避免标题为空的会话堆积，可通过 `/candy-title [提示词]` 手动触发 (#f6ca322)
- 命令增加生成中反馈：`/candy-title` 生成期间显示进度反馈，不再静默等待 (#80637be)
- 支持配置专用生成模型：标题生成可指定独立模型，不占用主对话模型配额，也便于用便宜模型生成标题 (#a8b117d)
- 支持命令配置并合并入 `/candy-title`：配置查看/修改整合为 `/candy-title config` 子命令，交互入口统一 (#07f2a34)
- autoFirst 默认改为开启：默认自动生成标题，无需用户先改配置 (#a01265b)
- maxTokens 与 maxLength 联动：标题长度限制与模型 token 预算联动，避免生成被中途截断 (#ba9cb27)
- 运行期报错改走 notify：工具运行期错误改用 notify 提示，不再输出到终端遮挡输入框 (#e90b325)
- 配置写入失败提示带上异常原因：写入失败时展示具体异常，便于排查权限/磁盘等问题 (#3ff724f)
- 空会话不再调模型编造标题：无内容会话跳过标题生成，节省 token 且不产生无意义标题 (#28d865b)

#### click-cursor

- 新增全屏点击定位光标工具：fullscreen 模式下点击输入框任意位置即移动光标，按显示宽度精确映射（中文/emoji 等宽字符点到字符间隙），类似 Claude Code 的点击编辑体验 (#edf2c40)
- 修复点击定位精度：列定位按显示宽度逐字符修正，消除多字节字符导致的偏移 (#9db7d46)
- 工具列表按添加顺序排列并同步文档：工具表格顺序固定为添加顺序，此后新增工具一律追加，保证文档可预期 (#e33f192)
- debug 日志改为写入文件：排查用日志写 `<logDir>/click-cursor.log`，不再打印到终端遮挡 UI (#a46dd02)
- 修复点击列精度：wrap 段起点与内容居中偏移校正，长行/换行场景点击列不再偏差 (#a2aa1b5)
- 点击定位与拖拽选择共存：按下放行、未移动的释放才判定为单击定位，拖拽选区/双击三击完全不受影响（VS Code 式交互） (#374c56c)
- 支持双击选词：双击/三击选词选行由 viewport 原生处理并自动复制，与单击定位共存不干扰 (#8c7d32d)
- 补编辑器外按下的 debug 日志：便于排查「点击未命中编辑器矩形」的定位问题 (#b9049b8)
- 新增 node --test 测试与 typecheck 配置：监听器前置、历史重建、鼠标序列判定等纯函数均有单测覆盖（17 用例），并配置 tsc --noEmit (#a038c5d)
- /resume 后重建编辑器历史，修复上下键失效：会话重建（reload / resume / fork / new）后按当前会话的用户消息重建编辑器 history——pi 的 populateHistory 只追加不清空、且换自定义编辑器时不搬运 history（官方 issue #7997/#8798 未修），本工具在 session_start 时幂等重建，保证 ↑↓ 历史切换可用 (#0369f72)
- autocomplete 条目点击改由 pi 原生处理：列表行点击放行给原生 Editor.handleMouse（pi ≥ 0.85 原生支持）选中条目；本工具只处理内容行，内容行边界改用 renderedVisibleLineCount（顺带修掉列表打开+文本滚动时点列表行误移光标的隐患） (#8b644b1)
- 文档说明计划退役与按功能选 pi 版本：pi 0.85 起官方原生实现点击定位（含 autocomplete 点击/拖拽选区/双击三击），本工具仅保留 debug 日志与会话历史重建价值，官方稳定后退役；根 README 增「按功能选 pi 版本」表 (#84f0f25)

#### transcript-jump

- 新增提问跳转工具：`/candy-jump`（快捷键 `alt+j`，仅全屏）打开当前会话提问列表，选中即滚动到对应组件行 (#6a8e630)
- 默认快捷键改为 alt+j：避免与其它插件/终端快捷键冲突 (#1706cd6)
- 列表只取当前分支：离线分支的提问不显示，避免跳转到不存在的组件行 (#adfb14e)
- 支持跳转到纯 skill 块提问：skill 块开头的提问可正确定位到对应 skill 组件行，不再跳空 (#eb6fed3)
- skill 提问一律跳 skill 组件：skill 块内的提问定位统一为 skill 组件行，消除不同提问类型的定位歧义 (#eb1e5c0)
- locatePromptRow 复用 LocateTarget 类型：定位逻辑与类型定义收敛复用，减少重复代码 (#61854c5)
- 打开选择器自动定位当前提问：选择器打开时预选距当前滚动位置最近的提问，减少翻找 (#02f0061)
- 自动定位改为选择器打开后异步执行：避免定位计算阻塞选择器渲染 (#2607172)
- 自动定位成功时记录调试日志：便于排查定位失败场景 (#2b44ce0)

### pi-candy-undo 1.0.0

- 新增设计与调研文档：pi-candy-undo 设计文档与 Claude Code `/rewind` 调研纪要，明确功能边界与实现取舍 (#01b3542)
- 补充 undo 粒度说明：明确回退到「目标时刻」的完整状态而非单回合，澄清用户预期 (#c34f3c6)
- 修订设计文档表述与外部插件引用：文档表述与实现对齐，外部引用更新 (#73fa213)
- 重构配置项设计并明确 redo 栈存储策略：redo 栈不随 fork/clone 迁移的设计决策明确写入 (#49d3ec1)
- 决策定稿并引入界面 i18n：回退界面的文案国际化，随 pi 语言切换 (#8f5da7e)
- 设计状态更新为已定稿（实施中）：设计文档状态标记更新 (#5b248da)
- 新增文件级撤销/重做插件：`/undo`、`/redo` 按用户消息回退对话与 agent 改过的文件（对标 Claude Code `/rewind`），支持 cwd 外文件、redo、快照/硬链接备份、会话隔离与过期清理 (#67ea9fe)
- 同步设计文档至实施结果并登记插件：文档与代码保持一致，并登记到插件列表 (#25de837)
- 源码注释统一改为中文：注释语言与仓库规范统一 (#53ec4a6)
- README 补充安装后生效时机与跟踪起点说明：明确插件安装前对文件的修改不会自动纳入跟踪，避免用户误预期 (#2e7bccc)
- 移除未使用的预留配置与 API 成员：清理预留项，避免误导使用者 (#bfca719)
- 统一「明确不做」说明并移除 /tree 集成预留：明确不做 /tree 集成，边界写进文档 (#eb25c22)
- 移除未使用的 SessionApi.isProjectTrusted 成员：清理死代码 (#5d72ed4)
- 明确配置合并语义：字段级深合并、数组整体替换、null 表示未设置，全部文档化 (#30ba234)
- 测试覆盖非法配置告警链路：非法配置的告警行为有单测兜底 (#39f5ec2)
- 回退说明增加提示图标：回退菜单的可读性提升 (#41c74ce)
- 回退菜单展示所选消息与相对时间：选择回退点时能直接看到目标消息内容与相对时间，选择更可靠 (#278ccff)
- 补全文件跟踪与回退的行为矩阵：各工具/场景的跟踪与回退行为矩阵完整化，便于查阅 (#a4d6882)
- README 补充可跟踪性建议与行为矩阵导航：行为矩阵加导航，快速定位到对应条目 (#c72ecf5)
- 文档强化文件修改工具的强制使用说明：强调 pi 中文件修改必须走 edit/write 等内置工具才会被跟踪（外部编辑器/直接改文件不会） (#bc8b1fb)
- 选择器支持搜索与翻页，替换原生 select：长会话下通过搜索/翻页快速定位回退点，替代原生下拉选择 (#1cc635c)

## 仓库公共

- 添加 .gitignore 和 .gitattributes：统一换行（LF）与忽略规则（node_modules、IDE 文件、日志等），跨平台行为一致 (#b5e95b9)
- 新增仓库根 README：插件列表（4 个插件 + 各自文档链接）、按功能选 pi 版本（0.85.1 / 0.84.4）、fullscreen 验证环境说明、npm 与本地两种安装方式 (#c5c108a)
- 新增 npm 发布流程 skill 与 preflight 检查脚本：登录（whoami）、线上版本、pack/publish dry-run、元数据结构、文件列表、peer optional 核查——脚本只读不发布、无任何绕过开关，未登录/待修正时要求先向用户确认 (#674059b)
- README 顶部标注验证环境为 fullscreen 模式：全部插件在全屏（alt-screen）模式下开发验证，推荐 settings.json 配 `{"tuiMode":"fullscreen"}`；pi 默认 regular 且不开启鼠标上报，click-cursor / transcript-jump 等鼠标类功能在 regular 下不可用 (#51eac99)
- npm 发布 skill 补 2FA 探测与浏览器认证步骤：真实发布探测 EOTP、安全密钥账号走 authUrl/doneUrl 浏览器认证（token 一次性、认证后趁窗口连发）、TOTP 账号用 --otp、账号级 auth-only 不免除发布 2FA 等实战经验固化进 skill (#39535d8)
- 新增 release 发布流程 skill 与 notes 生成脚本：release-YYYY.MM.DD 标签、插件/工具固定顺序（从仓库文件读取）、版本闸门（功能改动未升版本即阻断）、CHANGELOG 与 release body 内容一致、gh 自动创建 GitHub Release (#3dcc9b2)
- 发布类 skill 关闭模型自动触发：npm-publish 与 make-release 设为仅手动调用（/skill:xxx），避免模型在无关场景误触发发布流程 (#43e17a8)
