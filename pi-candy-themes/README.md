# pi-candy-themes

面向 [Pi](https://pi.dev) 的 Selenized 主题插件，为程序员精心调校的配色，专注于可读性与降低视疲劳。

配色表大部分来自 [Gogh](https://gogh-co.github.io/Gogh/) 收录的 Selenized 配色方案
（原始 Selenized 调色板由 [Jan Warchoł](https://github.com/jan-warchol/selenized) 设计）。

## 主题

共包含 4 个变体，对应 Selenized 的 4 种背景色调：

| 主题 | 背景 | 前景 | Gogh 对应配色 |
|-------|-----------|------------|----------------|
| `candy-selenized-black` | `#181818` | `#b9b9b9` | Selenized Black |
| `candy-selenized-dark`  | `#103c48` | `#adbcbc` | Selenized Dark |
| `candy-selenized-light` | `#fbf3db` | `#53676d` | Selenized Light |
| `candy-selenized-white` | `#ffffff` | `#474747` | Selenized White |

## 安装

### npm 安装

```bash
pi install npm:pi-candy-themes

pi -e npm:pi-candy-themes        # 临时试用，不写入配置
```

### 本地安装

```bash
git clone https://github.com/CandyMuj/pi-candy-extensions.git
cd pi-candy-extensions/pi-candy-themes   # 进入插件目录
pi install .                            # 安装当前目录

pi -e .                                 # 临时试用，不写入配置
```

本主题包无第三方依赖，两种方式都无需额外 `npm install`。

安装后可通过 `/settings` 选择主题，或在配置文件中直接设置：

```json
{
  "theme": "candy-selenized-dark"
}
```

## 调色板

每个主题使用其色调对应的 Selenized 配色方案（Gogh 终端配置中的 16 色 ANSI 配色，
外加仅用于 GUI 的橙色/紫色强调色）。

以 Selenized Black 的强调色为例：

| 名称    | Hex       |
|---------|-----------|
| red     | `#ed4a46` |
| green   | `#70b433` |
| yellow  | `#dbb32d` |
| blue    | `#368aeb` |
| magenta | `#eb6eb7` |
| cyan    | `#3fc5b7` |
| orange  | `#e67f43` |
| violet  | `#a580e2` |

## 重新生成

主题文件由 [`scripts/generate-themes.mjs`](scripts/generate-themes.mjs) 中的调色板数据生成，
保留该脚本便于后续 AI 编码时快速熟悉结构：

```bash
node scripts/generate-themes.mjs
```

## 许可证

MIT。Selenized 调色板由 Jan Warchoł 设计，配色收录自 Gogh。
