# click-cursor — 全屏模式点击定位光标

> 工具 id：`click-cursor` ｜ 无命令 ｜ 配置项：`debug`（默认 `false`）

## 功能

**仅 fullscreen 模式**生效：鼠标点击输入框（编辑器区域）内任意位置，光标移动到点击处——类似 Claude Code 的点击编辑体验。自动处理多行换行、滚动偏移、行尾边界，并按**显示宽度**精确定位（中文/emoji 等宽字符点击到字符间隙）。

## 配置

```json
{
  "click-cursor": {
    "debug": true
  }
}
```

- `debug`：开启后把鼠标事件、编辑器矩形、光标定位等日志**写入文件** `~/.pi/agent/candy-toolbox-click-cursor.log`（不打印到终端，避免遮挡 UI），便于排查点击定位问题（排查后建议关闭）

## 行为细节

- **左键按下**且落在编辑器矩形内 → 光标定位，事件被消费
- **其余一切事件**原样交给 pi 处理：滚轮滚动、右键粘贴、链接点击、编辑器外的点击、**编辑器内外的拖拽选区**——全部不受影响
- **点击与拖拽共存**：左键按下放行（viewport 建立选区锚点），未移动的释放判定为点击（移动光标并清除选区状态），移动则进入拖拽选择——输入框内可直接拖选复制
- **已知限制**：编辑器内的双击选词被点击定位取代（双击均视为点击定位）；autocomplete 弹出列表的点击被忽略（不选中条目、不移动光标）
- regular 模式下不生效（pi 不启用鼠标事件，无副作用）

## 方案逻辑

三个运行时机制配合实现（v1 已逐环验证）：

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
④ reload 后从 session 重建编辑器历史
     pi 在 /reload 时不会重新 populateHistory（内存历史可能丢失/错乱），
     从 sessionManager 的用户消息重建 history（幂等，其他启动路径不干预）

屏幕坐标 → 文本位置：
  布局溢出校正：布局总行数 > 终端高度时 TuiAltScreen 截取底部显示，
    rect 的 y 先换算为屏幕坐标（offsetY = 总行数 - 终端高度）
  点击 y（屏幕） - rect.y - 1（顶边框）→ 文本行
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

pi 升级导致任一失效时，工具自动退化为无点击定位，编辑器行为完全正常。

## 不变量（不影响既有功能）

- **编辑器始终是 pi 默认实例**：borderColor（bash/thinking 状态色）、autocomplete、undo 全部保留；history（↑↓ 切换）日常保留，reload 后由工具从 session 消息重建（内容等价，幂等）
- 键盘输入路径完全不变（焦点、keybindings 均未改动）
- 仅拦截「编辑器矩形内的左键按下」，其余鼠标事件原样交给 viewport

## 实现要点

- 单文件 `extensions/tools/click-cursor.ts`，`CustomEditor` 仅作类型引用（type-only import，运行时零额外依赖）
- 配置项仅 `debug`（默认关，日志开关）
- 安装生命周期：`session_start` 安装一次（`installed` 守卫）并重启轮询；`session_shutdown` 清理定时器，下次 session_start 自动恢复
- 鼠标事件统一由 `onTerminalInput` 监听器入口处理（viewport 对鼠标序列总是 consume，编辑器 handleInput 收不到鼠标，无需子类覆盖）
- reload 时（`session_start` reason 为 `reload`）从 session 消息重建编辑器 history，保证 ↑↓ 历史切换在 reload 后仍可用
