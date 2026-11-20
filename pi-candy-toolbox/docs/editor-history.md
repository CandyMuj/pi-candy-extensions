# editor-history — 会话重建后重建编辑器历史

> 工具 id：`editor-history` ｜ 无命令 ｜ 配置项：`debug`（默认 `false`）

## 功能

会话重建（`/reload`、`/resume`、`/fork`、`/new`）后按当前会话的用户消息重建编辑器历史，保证 ↑↓ 历史切换始终可用。幂等，不触碰编辑器其他状态。

**为什么需要**：pi 的编辑器历史只随提交追加、不清空，且换自定义编辑器（如 `pi-open-tui` 这类 `setEditorComponent` 扩展）时不搬运 history——官方 issue [#7997](https://github.com/earendil-works/pi/issues/7997) / [#8798](https://github.com/earendil-works/pi/issues/8798) 均为 `closed: not_planned`，至今未修。本工具是给这两个缺陷打的补丁，官方修复后即可退役。

## 与已退役的 click-cursor 的关系

本工具由原 `click-cursor` 拆分而来（toolbox 1.1.0 起）：

- **点击定位部分已退役**：pi `0.85.0` 起官方原生支持「点击输入框定位光标」（含 autocomplete 条目点击、拖拽选区、双击/三击选词），功能全覆盖，无需插件。
- **原插件存在一个未修复的定位缺陷**：超长文本换行后，**非第一行（换行段）的点击定位不准——无论点哪里光标都落在段首**。原因是插件用「段序号 × 整行宽度」近似段起点，渲染宽度与容器不一致或段宽非整宽时第二段起的偏移算错被钳制为 0。实测（pi-tui 1.5.2）**官方原生按段精确定位（`startCol` + 段内逐字符迭代），没有此缺陷**——这正是退役点击部分、改用原生的核心理由。
- **历史重建部分保留**：原生至今不提供（见上），迁移为本工具。

## 配置

```json
{
  "editor-history": {
    "debug": true
  }
}
```

- `debug`：开启后把重建过程写日志文件 `<logDir>/editor-history.log`（`logDir` 即插件级配置 `$toolbox.logDir`，默认 `~/.pi/candy-toolbox-logs`）；与插件级 `$toolbox.debug` 为「或」关系

## 方案逻辑

两个运行时机制配合实现：

```
① setWidget 工厂借用 tui 引用（按 key 隔离，零竞争）
     临时添加空 widget（placement: belowEditor）拿到 tui Proxy，随即按同一 key 移除；
     只动自己的 key——不影响其他扩展的 footer/widget/编辑器
② tui.children 定位编辑器实例（形状匹配 Editor：buildVisualLineMap / setCursorCol / state）
     会话重建时按当前会话的用户消息重建 history（与 pi 的 populateHistory 同语义：
     全部 user 消息、最新在前、相邻去重、限 100 条）
③ 每秒轮询检测编辑器实例变化
     扩展安装顺序不保证（自定义编辑器可能在本次 session_start 之后才替换实例），
     实例一变就再重建——覆盖 reload 后编辑器重建/替换的竞态
```

## 降级策略

| 依赖 | 失效表现 |
|---|---|
| widget 工厂 / `tui.children`（非严格契约） | 找不到编辑器 → 静默不工作，不影响任何既有功能 |
| 编辑器形状不匹配（自定义编辑器未继承 `Editor`） | 同上 |

## 实现要点

- 单文件 `extensions/tools/editor-history.ts`，`CustomEditor` 仅作类型引用（type-only import）
- 安装生命周期：`session_start` 安装一次（`installed` 守卫，且仅 `ctx.mode === "tui"`）并启动轮询；`session_shutdown` 清理定时器
- 不拦截任何输入：无 `onTerminalInput`、无鼠标逻辑（点击定位已交给官方原生）
