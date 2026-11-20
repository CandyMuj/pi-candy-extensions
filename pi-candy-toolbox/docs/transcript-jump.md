# transcript-jump — 全屏模式提问跳转

> 工具 id：`transcript-jump` ｜ 命令：`/candy-jump` ｜ 快捷键：`alt+j`（可配置）

## 功能

打开一个提问选择器，列出会话里**所有用户提问**（序号 + 单行预览 + 相对时间），**最近的排在前面**（序号仍按会话顺序编号），选中后把 fullscreen 转录滚动到对应位置。全程只移动滚动位置，**不回退会话、不切换会话活动点**（与 `/tree` 的本质区别）；被 `/compact` 压缩的旧提问打开**只读查看器**（原文 + 随后的助手回复），不滚动、不切换会话点。

选择器与 **pi 原生 select 同款样式**：替换编辑器区域全宽渲染（非弹窗），带边框、粗体标题与按键提示；此外比原生 select 多了输入过滤与翻页。

选择器交互（与 pi 的会话选择器同款）：

| 键 | 行为 |
|---|---|
| 输入 | 模糊过滤（实时） |
| `←` / `→`（或 PageUp/PageDown） | 翻页（一页 = 可视窗口） |
| `↑` / `↓` | 逐条选择 |
| `Enter` | 跳转 |
| `Esc` | 关闭 |

## 命令用法

```
/candy-jump          打开提问跳转列表
```

快捷键默认 `alt+j`，可配置（见下）。注意 Windows 终端会把 `Ctrl+Shift+字母` 折叠成 `Ctrl+字母`（例如 `Ctrl+Shift+J` 到达时是 `Ctrl+J`，pi 里是「插入换行」），自定义键位时请避开这类组合与终端保留组合。

## 配置项

配置位于 `~/.pi/agent/candy-toolbox.json`：

```json
{
  "transcript-jump": {
    "debug": false,
    "shortcut": "alt+j",
    "autoLocate": true,
    "diffViewMode": "auto"
  }
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `debug` | `false` | 调试日志开关：与插件级 `$toolbox.debug` 为「或」关系，任一为 `true` 即写 `<logDir>/transcript-jump.log`（跳转/降级/失败原因）；两者都为 `false` 时连日志目录都不会创建 |
| `shortcut` | `"alt+j"` | 打开提问列表的快捷键（KeyId 格式，见 pi keybindings 文档；避开 Ctrl+Shift+字母与终端保留组合，冲突时改这里） |
| `autoLocate` | `true` | 打开选择器时**异步**预选当前视口附近的提问（不阻塞打开）；关闭则始终默认选中最新，且不做任何组件遍历 |
| `diffViewMode` | `"auto"` | 查看器内 edit/write 的 diff 渲染方式：`auto`（内容宽度 ≥ 120 列用双栏，否则单栏；阈值与 pi-tool-display 的 `diffSplitMinWidth` 默认一致）/ `split`（双栏：删减在左、新增在右，按 hunk 配对对齐，长行按栏宽换行，行级着色）/ `unified`（单栏，官方 `renderDiff` 着色） |

## 方案逻辑

### 数据来源

- 列表：**当前分支**（`sessionManager.getBranch()`，leaf 到根的祖先链）上的**全部 user 消息**，**按时间倒序展示**（最近的在前，序号仍按会话顺序编号）；
- 被 `/tree` 切走的旧分支**不再展示**；压缩过的旧消息仍在分支上（只是不渲染），因此仍列出并标记「已压缩 · 可查看」；
- 预览折叠为单行，**不做固定字符数截断**：仅设 400 显示宽度的内存上限，视觉截断交给 SelectList 按终端宽度做（显示宽度感知，CJK/emoji 不破半字，超宽加省略号）。
- 可跳判定：`buildContextEntries()`（当前渲染集合）——不在其中的提问说明已被压缩。

### 定位机制（组件树，不依赖任何标记）

1. pi 把转录组件按会话顺序挂在 `documentContainer` 的 `chatContainer` 里（用户消息组件、助手组件、工具组件、空行……）；
2. 选中第 N 个提问后：数出**第 N 个用户消息组件**（按 `text + rebuild` 的形状识别），从渲染顶部开始逐个组件 `render` 测高并累加，得到该提问首行的精确行号；
3. `scrollView.scrollTo(row)` —— 提问正好置顶。

不读取/依赖 pi 的 OSC 133 标记（某些版本/插件组合下只有助手回复打标记），因此任何渲染环境一致；定位失败直接报错，不做猜测。压缩后的旧消息没有组件，走只读查看器（见下）；以 skill 块开头的提问（含带尾随正文的）一律定位到 skill 组件。

### 压缩项只读查看器

选中「已压缩 · 可查看」的提问时，打开**居中 overlay**（约 90% 宽、85% 高）只读查看器（标题：`历史提问 #N（已压缩 · 只读）`）：

- **渲染与折叠继承 pi 原生**：提问原文用 `UserMessageComponent`、助手消息用 `AssistantMessageComponent`、工具调用用 `ToolExecutionComponent`（均为官方导出）——markdown、主题与转录中的消息**完全一致**，美化主题插件自动同步；**thinking 默认折叠态随宿主 `hideThinkingBlock` 设置、工具调用默认折叠态随 `toolOutputExpanded` 设置**（与转录一致，读不到设置时用 pi 默认值）；**点击折叠/展开为组件内置能力，已在查看器接通**（点击对应行切换；转录级快捷键如 Ctrl+O 不在查看器中接管）；`edit` / `write` 的 diff 预览按 `diffViewMode` 配置渲染（`split` 双栏为自研排版，长行按栏宽换行、行级着色；`unified` 用官方 `renderDiff`）
- **键位与滚轮**：`↑`/`↓` 滚动、`PageUp`/`PageDown` 翻页、滚轮直达查看器（overlay 优先路由，不会带动转录）、`Esc`/`Enter` 返回列表（保持之前的选择位置）；提示行固定在正文上方，内容超高不被裁剪
- **自绘卡片与窗口滚动**：overlay 合成不带背景，查看器自绘 `customMessageBg` 底色（pi 自定义消息框同款，缺该 token 的主题降级为无底色）+ 完整盒边框，与转录背景清晰区隔；滚动为窗口切片（overlay 子组件无布局测量，ScrollView 不可用），滚轮由 `handleMouse` 消费
- 全程**不滚动转录、不切换会话活动点**——数据来自 `sessionManager.getEntries()` 的原始条目，被压缩的原文仍在会话文件里，只读展示即可
- 任何失败（如读取不到原文）：notify 后**停在当前**，不做任何滚动
- **已知局限**：

  1. 其它扩展注册的 markdown transformer（`pi.registerMarkdownTransformer`）目前没有读取 API，依赖 transformer 的美化（如图片渲染类插件）在查看器中不生效
  2. 工具调用为通用兜底渲染——`pi-tool-display` 等通过注册工具定义注入的**自定义工具渲染器**同样无法被扩展读取（无 API），查看器用官方 `ToolExecutionComponent` 渲染（含折叠/点击展开）；内置 `edit` / `write` 的 diff 预览用官方 `renderDiff` 复刻，其余工具为通用兜底

  主题/样式类美化不受影响；若 pi 后续开放 transformer / 工具定义读取能力，再接入以完全对齐

**为什么不用重渲染跳转（`ctx.navigateTree`）**：那正是 `/tree` 的机制——把会话活动点（leaf）切到历史条目再整体重渲染，虽然能让旧消息出现在转录里，但有这些不可接受的代价：

1. 后续发消息会从那个历史点**分支**（会话点被永久切换）
2. 导航离开当前点可能触发**分支摘要**（模型调用），纯查看代价过大
3. 转录区域**没有直接渲染通道**：pi 未开放「在转录历史位置渲染内容」的扩展 API——`chatContainer` / `renderSessionEntries` 均为内部实现，widget 只能挂编辑器上下方（`aboveEditor` / `belowEditor`），`sendMessage` 虽能把自定义消息注入转录，但它会**追加一条持久会话条目**且只出现在末尾、无法移除。要在转录里看历史，唯一路径就是 navigateTree 整体重渲染（必然切换会话点）——因此查看器只能用独立渲染区域（overlay 卡片），不碰转录

本工具的目标只是「看历史消息」，所以选择只读查看器：不碰会话树，看完即回。

## 已知限制

- **仅 fullscreen 可跳**（alt-screen 才有转录行与 ScrollView）；regular（inline）/ print / json / rpc 不可用（regular 下列表能开，选中后提示）；
- **`/compact` 后**旧消息不渲染：旧提问走只读查看器（见上），不滚动、不切换会话点；
- 依赖 tui 内部结构（`tui.children` 的 document/chat 容器顺序与组件 `render` 测高，无官方公开 API），与 editor-history 同级别的**无回归保证**：行号越界/组件渲染失败时直接报错，pi 升级后建议跑一遍 `npm test` 回归；
### 定位与跳转

- **跳转**：skill 块开头的提问一律定位到 skill 组件，其余定位到用户组件（`locateTarget` 返回 `{ kind, ordinal }`，两类序号各自与渲染组件一一对应）；
- **自动定位（`autoLocate`）**：打开选择器时异步读取当前 `scrollTop`，用同一次组件遍历取全部提问首行（`collectPromptRows`），取「首行 ≤ scrollTop」的最近一条提问预选（`promptIdAtRow`）；定位失败静默回退默认选中最新；用户已输入过滤或移动过选择时不覆盖；
- 不依赖 OSC 133 标记：pi 改标记规则、部分插件 strip 标记、`/btw` 侧线程等都不影响定位。

## 实现要点

- 单文件 `extensions/tools/transcript-jump.ts`；`JumpDialog` 用 `Container + Input + SelectList` 拼装，**非 overlay**（`ctx.ui.custom` 直接替换编辑器区域，与原生 select 同款形态），左右翻页按 pi 会话选择器同款键位匹配（`tui.editor.cursorLeft/Right` + `tui.select.pageUp/pageDown`）
- 核心纯函数（可单测）：`listPrompts` / `userIsLocatable` / `startsWithSkillBlock` / `locateTarget` / `collectPromptRows` / `promptIdAtRow` / `isUserMessageComponent` / `isSkillComponent` / `renderHeight` / `locatePromptRow` / `findTranscriptContainers` / `transcriptGeometry` / `formatRelativeTime` / `scrollToRow`
- 命令与快捷键共用同一个 `openPicker` 入口；`ctx.mode !== "tui"` 时直接返回
- 依赖：运行时使用 pi 提供的 `@earendil-works/pi-tui`（测试环境作为 devDependency 安装）
