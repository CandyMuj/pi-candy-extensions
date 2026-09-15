# transcript-jump — 全屏模式提问跳转

> 工具 id：`transcript-jump` ｜ 命令：`/candy-jump` ｜ 快捷键：`alt+j`（可配置）

## 功能

打开一个提问选择器，列出会话里**所有用户提问**（序号 + 单行预览 + 相对时间），**最近的排在前面**（序号仍按会话顺序编号），选中后把 fullscreen 转录滚动到对应位置。全程只移动滚动位置，**不回退会话**（与 `/tree` 的本质区别）；被 `/compact` 压缩的旧提问降级定位到会话顶部（摘要处）。

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
    "shortcut": "alt+j"
  }
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `debug` | `false` | 调试日志开关：与插件级 `$toolbox.debug` 为「或」关系，任一为 `true` 即写 `<logDir>/transcript-jump.log`（跳转/降级/失败原因）；两者都为 `false` 时连日志目录都不会创建 |
| `shortcut` | `"alt+j"` | 打开提问列表的快捷键（KeyId 格式，见 pi keybindings 文档；避开 Ctrl+Shift+字母与终端保留组合，冲突时改这里） |

## 方案逻辑

### 数据来源

- 列表：**当前分支**（`sessionManager.getBranch()`，leaf 到根的祖先链）上的**全部 user 消息**，**按时间倒序展示**（最近的在前，序号仍按会话顺序编号）；
- 被 `/tree` 切走的旧分支**不再展示**；压缩过的旧消息仍在分支上（只是不渲染），因此仍列出并标记「已压缩」；
- 预览折叠为单行，**不做固定字符数截断**：仅设 400 显示宽度的内存上限，视觉截断交给 SelectList 按终端宽度做（显示宽度感知，CJK/emoji 不破半字，超宽加省略号）。
- 可跳判定：`buildContextEntries()`（当前渲染集合）——不在其中的提问说明已被压缩。

### 定位机制（组件树，不依赖任何标记）

1. pi 把转录组件按会话顺序挂在 `documentContainer` 的 `chatContainer` 里（用户消息组件、助手组件、工具组件、空行……）；
2. 选中第 N 个提问后：数出**第 N 个用户消息组件**（按 `text + rebuild` 的形状识别），从渲染顶部开始逐个组件 `render` 测高并累加，得到该提问首行的精确行号；
3. `scrollView.scrollTo(row)` —— 提问正好置顶。

不读取/依赖 pi 的 OSC 133 标记（某些版本/插件组合下只有助手回复打标记），因此任何渲染环境一致；定位失败直接报错，不做猜测。压缩后的旧消息没有组件，降级滚到会话顶部（摘要处）；纯 skill 块提问渲染成 skill 组件，跳转到该组件位置。

### 压缩降级

选中"已被压缩"的提问时，滚动到会话顶部（摘要位置）并 notify 说明。真正回看旧原文需要 `/tree` 展开那类重建渲染的能力，超出"只滚动"的定位。

## 已知限制

- **仅 fullscreen 可跳**（alt-screen 才有转录行与 ScrollView）；regular（inline）/ print / json / rpc 不可用（regular 下列表能开，选中后提示）；
- **`/compact` 后**旧消息不渲染：旧提问降级到顶部摘要处，见上；
- 依赖 tui 内部结构（`tui.children` 的 document/chat 容器顺序与组件 `render` 测高，无官方公开 API），与 click-cursor 同级别的**无回归保证**：行号越界/组件渲染失败时直接报错，pi 升级后建议跑一遍 `npm test` 回归；
- 不依赖 OSC 133 标记：pi 改标记规则、部分插件 strip 标记、`/btw` 侧线程等都不影响定位。

## 实现要点

- 单文件 `extensions/tools/transcript-jump.ts`；`JumpDialog` 用 `Container + Input + SelectList` 拼装，**非 overlay**（`ctx.ui.custom` 直接替换编辑器区域，与原生 select 同款形态），左右翻页按 pi 会话选择器同款键位匹配（`tui.editor.cursorLeft/Right` + `tui.select.pageUp/pageDown`）
- 核心纯函数（可单测）：`listPrompts` / `userIsLocatable` / `locatableUserOrdinal` / `isUserMessageComponent` / `renderHeight` / `locateUserPromptRow` / `findTranscriptContainers` / `transcriptGeometry` / `formatRelativeTime` / `scrollToRow`
- 命令与快捷键共用同一个 `openPicker` 入口；`ctx.mode !== "tui"` 时直接返回
- 依赖：运行时使用 pi 提供的 `@earendil-works/pi-tui`（测试环境作为 devDependency 安装）
