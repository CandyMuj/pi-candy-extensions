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

| 插件 | npm 安装 | 说明 | 文档 |
|------|--------|------|------|
| [pi-candy-themes](pi-candy-themes) | `pi install npm:pi-candy-themes` | Selenized 配色主题包 | [README](pi-candy-themes/README.md) |
| [pi-candy-win-notify](pi-candy-win-notify) | `pi install npm:pi-candy-win-notify` | Windows 桌面通知 + 终端标签页状态显示 | [README](pi-candy-win-notify/README.md) |
| [pi-candy-toolbox](pi-candy-toolbox) | `pi install npm:pi-candy-toolbox` | 小工具聚合箱：一个插件收纳零散小功能，每个工具独立开关与配置 | [README](pi-candy-toolbox/README.md) |
| [pi-candy-undo](pi-candy-undo) | `pi install npm:pi-candy-undo` | 文件级撤销/重做（对标 Claude Code `/rewind`）：`/undo`、`/redo`，回退对话与 agent 改过的文件 | [README](pi-candy-undo/README.md) |

## 安装

本仓库是 monorepo：多个插件同处一个仓库、各自独立安装。**pi 不支持从 git 仓库的某个子文件夹安装插件**（`pi install git:...` 只能装仓库根目录的包），而这里不想一个仓库只放一个插件，因此请按下面的方式逐个安装。

### npm 安装

包名与目录名相同：

```bash
pi install npm:pi-candy-undo      # 包名见上方插件列表

pi -e npm:pi-candy-undo           # 临时试用，不写入配置
```

npm 安装由 pi 自动执行 `npm install`，无需手动处理依赖。

### 本地安装

```bash
git clone https://github.com/CandyMuj/pi-candy-extensions.git
cd pi-candy-extensions/pi-candy-undo   # 目录名见上方插件列表
npm install                            # 可选：仅带第三方依赖的插件需要
pi install .                           # 安装当前目录

pi -e .                                # 临时试用，不写入配置
```

本地路径安装**不会**自动安装依赖，是否需要 `npm install` 见各插件 README；上面的命令仅为示例。

各插件的依赖与配置细节见各自 README；`pi-candy-toolbox` 内各工具的详细文档见其 `docs/` 目录。

## 仓库约定

- 新插件命名统一 `pi-candy-` 前缀
- 每个插件独立成目录、独立安装、互不依赖
- 插件细节不进本 README，直接看各自文档
