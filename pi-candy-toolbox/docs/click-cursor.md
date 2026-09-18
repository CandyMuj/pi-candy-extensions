# click-cursor — 全屏模式点击定位光标

> 工具 id：`click-cursor` ｜ 无命令 ｜ 配置项：`debug`（默认 `false`）
>
> **⚠️ 计划退役：pi `0.85.0` 起官方已原生实现本工具的功能，待官方实现稳定后本工具将从工具箱移除。**
>
> - **推荐 pi `0.85.1`（或 ≥ `0.85.0`）**：官方原生支持点击输入框定位光标，且额外覆盖 autocomplete 条目点击、编辑器上拖拽选区、双击/三击选词；`0.85.1` 又修掉了原生点击的 hover 误选条目问题。此类版本上本工具可直接关闭（`{"click-cursor": false}`），仅剩两个保留理由：① `debug` 日志（官方无此能力）② 会话重建后重建编辑器历史（见下文 ⑤，pi 自身缺陷）
> - **pi `0.84.x` 及更早**：官方没有原生点击定位，该功能只能由本工具提供（本工具即在此区间开发验证）
> - 详情与证据（引入版本、官方 issue、与原生实现的分工）见下文《与官方原生实现的关系》

## 与官方原生实现的关系

pi `0.85.0`（2026-09-04）引入了原生点击定位光标：`Editor.handleMouse` 处理 viewport 派发的 click 事件，
按显示宽度 + grapheme 分段把点击位置映射为光标位置——与本工具的核心算法同思路，
且额外支持 autocomplete 条目点击（本工具改为放行给原生）、拖拽选区、双击/三击选词。
`0.84.4`（最后一个 `0.84.x`）不含该能力。

本工具与官方的分工：

| 能力 | 官方原生（≥ `0.85.0`） | 本工具 |
|------|:---:|:---:|
| 点击输入框定位光标（显示宽度/grapheme） | ✅ | ✅ |
| 仅 fullscreen 生效（regular 不抓鼠标） | ✅ | ✅ |
| 编辑器上拖拽选区 / 双击三击选词 | ✅ | ✅（放行给 viewport） |
| autocomplete 列表条目点击 | ✅ | ✅（本工具放行给原生） |
| `debug` 日志（写文件排查） | ❌ | ✅ |
| 会话重建后重建编辑器历史 | ❌（见 ⑤） | ✅ |

官方侧仍存在的缺陷（本工具 ⑤ 项仍在补）：`Editor.history` 是实例私有字段、`setEditorComponent` 换编辑器时不搬运 history、
`/reload` 不重新灌历史——扩展注册的自定义编辑器（如 `pi-open-tui`）每次 `/reload` 都会丢历史、↑↓ 失效（官方 issue #7997 / #8798 被机器人自动关闭，未修）。

## 功能

**仅 fullscreen 模式生效**：鼠标点击输入框（编辑器区域）内任意位置，光标移动到点击处——类似 Claude Code 的点击编辑体验。自动处理多行换行、滚动偏移、行尾边界，并按**显示宽度**精确定位（中文/emoji 等宽字符点击到字符间隙）。

autocomplete 列表行的点击不由本工具处理，而是**放行给 pi 原生**（`Editor.handleMouse` 的 autocomplete 分支，pi ≥ `0.85.0`）——条目选中用官方实现，本工具只管内容行；`0.84.x` 没有原生分支时，该点击等同于被忽略（与旧行为一致）。

可用性由 pi 决定：**鼠标上报只在 fullscreen（alt-screen）下开启**，regular（inline）模式主屏不开启鼠标上报，工具收不到任何鼠标序列。安装本身另带 `ctx.mode !== "tui"` 守卫：print / json / rpc 等 headless 模式没有 TUI（widget 工厂不会执行），直接不安装。

## 配置

```json
{
  "click-cursor": {
    "debug": true
  }
}
```

- `debug`：开启后把鼠标事件、编辑器矩形、光标定位等日志**写入文件** `<logDir>/click-cursor.log`（`logDir` 即插件级配置 `$toolbox.logDir`，默认 `~/.pi/candy-toolbox-logs`；不打印到终端，避免遮挡 UI），便于排查点击定位问题（排查后建议关闭）
- 与插件级开关的关系：`$toolbox.debug` 或本工具 `debug` 任一为 `true`，本工具就写日志（两个开关是「或」关系）；两者都为 `false` 时连日志目录都不会创建

## 行为细节

- **编辑器矩形内、未移动的左键释放（单击）** → 光标定位，并消费该次释放（按下始终放行，不再消费任何按下）
- **其余一切事件**原样交给 pi 处理：滚轮滚动、右键粘贴、链接点击、编辑器外的点击、**编辑器内外的拖拽选区**——全部不受影响
- **点击/双击/三击/拖拽共存**（VS Code 式）：左键按下放行，未移动的释放判定为单击（移动光标并清除选区状态）；双击/三击由 viewport 原生处理（选词/选行 + 自动复制，不干预）；移动则进入拖拽选择
- **autocomplete 列表行**：点击放行给 pi 原生（条目选中由原生处理）；仅当 pi 的 `autocompleteState` / `renderedVisibleLineCount` 取不到时退化为「忽略该次点击」
- regular 模式下不生效（pi 不启用鼠标事件，无副作用）

## 方案逻辑

以下环节配合实现（① ② ③ 为 v1 已逐环验证的运行时机制，④ ⑤ 为后续新增）：

```
① setWidget 工厂借用 tui 引用（按 key 隔离，零竞争）
     临时添加空 widget（placement: belowEditor）拿到 tui Proxy，随即按同一 key 移除；
     widget 按 key 管理，只动自己的 key——不影响其他扩展的 footer/widget，
     也不碰编辑器（history/borderColor/autocomplete/undo 全部保留）
② onTerminalInput 监听器 + ensureFirst 前置（安装时立即前置 + 每秒轮询兜底）
     fullscreen 下 pi 已启用 SGR 1006 鼠标；viewport 监听器在 inputListeners 中
     位于扩展监听器之前并对鼠标事件一律 consume——必须前置才能先收到点击。
     轮询兜底覆盖模式切换 rebind 后的重新前置（否则 reload 后直接点击会因
     监听器未前置而永远收不到鼠标事件）
③ tui.currentLayout + tui.children
     每次渲染后布局树含每个 layout node 的 rect；编辑器实例从 tui.children 的
     editorContainer 中动态定位（pi 默认编辑器实例，非替换产物）
④ autocomplete 列表行放行给原生
     列表行判定与 pi 对齐：局部行号（y - rect.y）≥ renderedVisibleLineCount + 2
     （行序：顶边框 0 → 内容 1..N → 底边框 N+1 → 列表 N+2..）。命中则不消费按下/释放、
     不清选区——原生的点击合成（tui-alt-screen 的屏幕选区路径）靠选区锚点判定 isClick，
     清掉或消费都会让它收不到点击，条目就无法选中
⑤ 会话重建后按当前会话重建编辑器历史
     /reload、/resume、/fork、/new 等 reason 下 pi 的 populateHistory 只追加不清空，
     且可能发生在编辑器实例重建之前——从 sessionManager 的用户消息重建 history（幂等；startup 走 pi 自身流程，不干预）

屏幕坐标 → 文本位置：
  布局溢出校正：布局总行数 > 终端高度时 TuiAltScreen 截取底部显示，
    rect 的 y 先换算为屏幕坐标（offsetY = 总行数 - 终端高度）
  点击 y（屏幕） - rect.y - 1（顶边框）→ 文本行（内容行数取 renderedVisibleLineCount，
    不用 rect.height——autocomplete 打开时高度含列表行）
    + scrollOffset → buildVisualLineMap(lastWidth)（word-aware 换行）→ 逻辑行
  点击 x - rect.x - paddingX → 段起点（wrap 行按 segIndex × lastWidth 近似）
    → 按显示宽度逐字符映射（东亚宽字符/emoji 宽 2）→ 精确码元列
  state.cursorLine = 逻辑行; setCursorCol(col); tui.requestRender()
```

## 降级策略

依赖三个 pi 运行时细节（均为官方公开字段或官方 API，但非严格契约）：

| 依赖 | 失效表现 |
|---|---|
| `inputListeners` 运行时字段 + Set 顺序 | 点击定位不生效（不破坏其他功能），代码含防御检查 |
| `tui.currentLayout` / `tui.children`（TS private） | 同上，静默降级 |
| `buildVisualLineMap` / `setCursorCol` / `state.cursorLine` / `state.lines`（TS private） | 同上 |
| `autocompleteState` / `renderedVisibleLineCount`（TS private） | 列表行点击无人处理 → 退化为旧行为（点击被忽略，条目选不中；内容行定位不受影响） |

pi 升级导致任一失效时，工具自动退化为无点击定位，编辑器行为完全正常。

## 不变量（不影响既有功能）

- **编辑器始终是 pi 默认实例**：borderColor（bash/thinking 状态色）、autocomplete、undo 全部保留；history（↑↓ 切换）日常保留，reload 后由工具从 session 消息重建（内容等价，幂等）
- 键盘输入路径完全不变（焦点、keybindings 均未改动）
- 仅消费「编辑器矩形内未移动的左键释放」，其余鼠标事件原样交给 viewport

## 实现要点

- 单文件 `extensions/tools/click-cursor.ts`，`CustomEditor` 仅作类型引用（type-only import，运行时零额外依赖）
- 配置项仅 `debug`（默认关，日志开关；与插件级 `$toolbox.debug` 为「或」关系）
- 安装生命周期：`session_start` 安装一次（`installed` 守卫，且仅 `ctx.mode === "tui"`）并重启轮询；`session_shutdown` 清理定时器，下次 session_start 自动恢复
- 鼠标事件统一由 `onTerminalInput` 监听器入口处理（viewport 对鼠标序列总是 consume，编辑器 handleInput 收不到鼠标，无需子类覆盖）
- autocomplete 列表行点击：按下与释放**都放行**（原生的点击是「按下建立选区锚点 → 释放同格合成 click → dispatch 给 Editor」）；内容行仍由本工具消费释放
- 会话重建时（`session_start` reason 非 `startup`：reload / resume / fork / new）从 session 消息重建编辑器 history，保证 ↑↓ 历史切换在会话切换后仍可用
