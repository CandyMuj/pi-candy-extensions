# pi-candy-extensions 🍬

个人 pi 插件集合仓库。

> **⚠️ 开发验证版本：pi `0.84.3`**
>
> 本仓库所有插件均在此版本下开发、验证（扩展 API 与 TUI 内部机制以该版本为准）。pi 后续更新可能导致部分插件不可用（尤其是依赖 TUI 内部机制的 `pi-candy-toolbox` 的 click-cursor 工具）；若更新后出现问题，可临时回退到本版本：
>
> ```bash
> # 以 npm 全局安装为例（按你的实际安装方式调整）
> npm install -g @earendil-works/pi-coding-agent@0.84.3
> ```
>
> 回退验证正常后，如需升级请逐个插件回归测试后再升。

## 插件列表

| 插件 | 说明 | 文档 |
|------|------|------|
| [pi-candy-themes](pi-candy-themes) | Selenized 配色主题包 | [README](pi-candy-themes/README.md) |
| [pi-candy-win-notify](pi-candy-win-notify) | Windows 桌面通知 + 终端标签页状态显示 | [README](pi-candy-win-notify/README.md) |
| [pi-candy-toolbox](pi-candy-toolbox) | 小工具聚合箱：一个插件收纳零散小功能，每个工具独立开关与配置 | [README](pi-candy-toolbox/README.md) |
| [pi-candy-undo](pi-candy-undo) | 文件级撤销/重做（对标 Claude Code `/rewind`）：`/undo`、`/redo`，回退对话与 agent 改过的文件 | [README](pi-candy-undo/README.md) |

## 安装

各插件以本地目录方式安装（仓库根目录为 `pi-candy-extensions`）：

```bash
cd pi-candy-extensions
pi install ./pi-candy-themes     # 目录名见上方插件列表
```

依赖与配置细节见各插件 README；toolbox 内各工具的详细文档见其 `docs/` 目录。

## 仓库约定

- 新插件命名统一 `pi-candy-` 前缀
- 每个插件独立成目录、独立安装、互不依赖
- 插件细节不进本 README，直接看各自文档
