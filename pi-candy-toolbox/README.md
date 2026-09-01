# pi-candy-toolbox 🍬🧰

pi 的小工具聚合箱 —— 收纳零散的小功能、小工具。与其为每个小功能单独装一个插件，不如都收进这个工具箱：**一个插件、一个配置文件、每个工具独立开关**。

## 安装

本项目以本地目录方式安装（仓库根目录为 `pi-candy-extensions`）：

```bash
cd pi-candy-extensions
pi install ./pi-candy-toolbox
```

无第三方运行时依赖，安装后无需额外 `npm install`。安装完成后 `/reload` 生效，启动时控制台会打印每个工具的启用状态。

## 配置文件

配置文件位于 `~/.pi/agent/candy-toolbox.json`，不存在时所有工具按默认值启用。

每个工具拥有一个**独立的顶层 key（工具 id）**，key 下放该工具的具体配置。开关支持三种写法：

```json
{
  "hello": true,
  "some-tool": false,
  "fancy-tool": {
    "enabled": true,
    "optionA": "自定义值",
    "optionB": 42
  }
}
```

| 写法 | 效果 |
|------|------|
| `"tool-id": true` | 启用，使用该工具的默认配置 |
| `"tool-id": false` | 禁用 |
| `"tool-id": { ... }` | 启用，字段与默认配置浅合并覆盖（也可写 `{ "enabled": false }` 禁用） |
| （未提及） | 按工具的 `defaultEnabled` 决定，默认启用 |

编辑配置文件后需重启 pi（或 `/reload`）生效。

## 已有工具

| 工具 id | 说明 | 文档 | 默认 |
|---------|------|------|------|
| `click-cursor` | 全屏模式点击输入框移动光标（无命令） | [docs/click-cursor.md](docs/click-cursor.md) | 启用 |
| `hello` | 示例工具：注册 `/candy-hello` 命令 | — | 关闭 |
| `session-title` | 生成/重新生成会话标题：`/candy-title [提示词]`，`config` 子命令查看/修改配置 | [docs/session-title.md](docs/session-title.md) | 启用 |

## 添加新工具

每个工具一个文件或一个目录，互不干扰。**渐进式**：简单工具用单文件，变复杂后随时可以升级为目录：

```
extensions/
├── index.ts              # 入口：加载配置 + 工具清单
├── core/
│   └── config.ts         # 配置读取与归一化（一般不用改）
└── tools/
    ├── _template.ts      # 新工具模板（复制它）
    ├── hello.ts          # 示例：简单工具 = 单文件
    └── notify/           # 示例：复杂工具 = 目录（目录名 = 工具 id）
        ├── index.ts      #   入口，导出 ToolDefinition（与单文件完全一致）
        ├── host.ps1      #   资源文件
        ├── utils.ts      #   私有子模块
        └── tests/        #   工具自带测试（不会被加载）
```

三步添加新工具：

1. 复制 `extensions/tools/_template.ts` 为 `extensions/tools/<tool-id>.ts`（简单）或 `extensions/tools/<tool-id>/index.ts`（复杂），改 `id`、`description`、`defaultConfig`，实现 `register()`；
2. 在 `extensions/index.ts` 的 `TOOLS` 清单中 import 并加一行（目录工具 import 路径到目录即可，自动解析 `index.ts`）；
3. 可选：在 `candy-toolbox.json` 中用工具 id 配置开关。

约定：

- 工具文件/目录默认导出一个 `ToolDefinition`：`id`（配置 key）+ `defaultConfig` + `register(pi, config)`，目录工具的入口同样是 `index.ts` 导出 `ToolDefinition`，接口一致
- `register` 只在工具**启用时**被调用，不用自己判断开关；拿到的是合并后的最终配置
- 配置中未提到的工具默认启用；有副作用、需要用户确认的工具可设 `defaultEnabled: false`
- 单文件升级为目录是纯增量操作：把文件移入新目录改名为 `index.ts`，清单中 import 路径加目录名即可
- 新增工具后顺手更新本 README 的「已有工具」表格

## 工具文档

每个工具配一篇文档，说明功能、用法、配置与方案逻辑，避免本 README 过度膨胀。存放规则：

- **单文件工具**（简单）：文档统一放 `docs/<tool-id>.md`，例如 `docs/session-title.md`
- **目录工具**（复杂）：文档放工具目录内 `README.md`（与代码同处，便于随工具整体移动/分发）
- 「已有工具」表格的「文档」列引用对应文档；新增工具后同步补充

统一文档模板：功能说明 → 命令用法 → 配置项表 → 方案逻辑 → 实现要点。
