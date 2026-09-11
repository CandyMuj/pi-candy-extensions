# pi-candy-win-notify

> **本项目基于 [pi-desktop-notify](https://github.com/ryanchan720/pi-desktop-notify) 项目修改而来。** 上游仓库名为 `pi-desktop-notify`，其插件名（npm 包名）为 **pi-win-notify**，两者并不相同。拉取的是上游 main 分支的 [5889e19](https://github.com/ryanchan720/pi-desktop-notify/commit/5889e19) 提交，在此基础上保留了原有桌面通知功能，并扩展了终端标签页状态显示。

[pi](https://pi.dev) 桌面通知工具 + 终端标签页状态显示。pi 完成任务时右下角弹出暗色窗口，切到其他程序也不错过；同时通过终端标题与原生进度指示实时展示任务状态，多窗口并行时一眼看清哪个会话还在跑、哪个已完成。终端在前台时自动跳过弹窗。

## 安装

### npm 安装

```bash
pi install npm:pi-candy-win-notify

pi -e npm:pi-candy-win-notify     # 临时试用，不写入配置
```

### 本地安装

```bash
git clone https://github.com/CandyMuj/pi-candy-extensions.git
cd pi-candy-extensions/pi-candy-win-notify   # 进入插件目录
npm install                                  # koffi 及其 Windows 原生模块（本地安装不会自动装依赖）
pi install .                                 # 安装当前目录

pi -e .                                      # 临时试用，不写入配置
```

## 使用

| 命令 | 说明 |
|---------|-------------|
| `/notify` | 开关切换 |
| `/notify on` / `off` | 强制开关 |
| `/notify timeout 15` | 自动消失秒数 (5~60, 默认 15) |
| `/notify opacity 1.0` | 窗口不透明度 (0.3~1.0) |
| `/notify message fixed` | 固定完成文本 |
| `/notify message response` | AI 回复前 50 字（默认） |
| `/notify lang zh` | 语言：`zh` `en` `ja` `ko`（默认 `zh`） |
| `/notify title <状态> <native\|compat\|both>` | 设置某状态在终端标签页的显示模式 |
| `/notify title` | 查看全部状态的显示模式 |
| `/notify status` | 守护进程状态 + 当前配置 |

## 特性

### 桌面通知（上游原有）

- ⚡ **快速聚焦** — 点击按钮或 **Alt+]** 一键切回终端。**Alt+[** 关闭弹窗
- 👁 **回复预览** — 弹窗直接显示 AI 回复前 50 字，或固定完成文本
- ⏱ **耗时显示** — 显示任务耗时
- 🔕 **勿扰** — 3 分钟 / 30 分钟 / 1 小时 / 关闭。持久化，重启不丢。多实例自动同步
- 🌐 **多语言** — `zh` / `en` / `ja` / `ko`
- 🪟 暗色圆角弹窗，右下角，跟光标走
- 🔝 置顶、不抢焦点、可配不透明度、自动消失
- 🤖 自动抑制 LLM 重试和上下文压缩期间的弹窗
- 📝 通知标题 = 用户 prompt 前 25 字
- 📚 多 pi 窗口堆叠

### 终端标签页状态显示（本插件扩展）

pi 在终端标签页展示四种任务状态，多窗口并行时无需逐个切回即可判断进度：

| 状态 | 触发时机 | 原生显示（native） | 兼容显示（compat） |
|---|---|---|---|
| 执行中 | `agent_start` | 标签页原生转圈动画 | 标题盲文动画 `⠋⠙⠹…` |
| 等待用户 | 提问工具（如 `ask_user_question`）执行时 | 暂停指示（OSC 9;4 st=4） | 标题 `⏳` |
| 完成 | 任务结束且无错误 | 进度 100% 绿勾（st=1;100） | 标题 `✅` |
| 失败 | 任务被中断或不可重试错误 | 错误红叉（st=2） | 标题 `❌` |

- **两种显示方式可分别配置**：`native` 使用终端原生的 OSC 9;4 进度指示（Windows Terminal、WezTerm、Ghostty、iTerm2 等支持）；`compat` 使用标题 emoji/动画（任何终端都能显示）。每个状态可独立选择 `native` / `compat` / `both`（两者同时显示），默认 `running=native`、其余 `both`
- **失败判定**：用户强制中断（Esc）或不可重试的 API/工具错误（如鉴权失败）计为失败；可重试错误（超时、限流等）不算
- **标题格式**：`状态图标 会话名 - 目录名 [pi@进程标识]`，末尾的 `[pi@pid]` 是窗口唯一标识，供通知弹窗"继续"按钮在多窗口下精确切回
- **兼容任何终端**：即使终端不支持 OSC 9;4，标题 emoji 也能完整表达四态

## 关闭勿扰

勿扰期间通知弹窗不再出现，**无法直接在弹窗中解除**。解除流程：

1. 先执行 `/notify on` 临时恢复通知
2. 等下一次任务完成、通知弹窗出现后，点击弹窗 🔕 按钮，选择「**关闭勿扰**」——此时才会同时清除 `muteUntil` 时间戳，彻底解除

> ⚠️ **注意（可能复活）**：`/notify on` 只是临时恢复通知，**不会**清除 `muteUntil` 时间戳。若只执行了 `/notify on` 而未在弹窗中选择「关闭勿扰」，在勿扰到期前重启 pi，勿扰状态会**复活**（启动时自动恢复为勿扰）。

## 配置

配置文件位于 `~/.pi/agent/candy-win-notify.json`。不存在或字段缺失时使用默认值，以下是全部配置项及其默认值：

```json
{
  "timeout": 15,
  "opacity": 1.0,
  "messageMode": "response",
  "lang": "zh",
  "muteUntil": null,
  "titleStatus": {
    "running": "native",
    "waiting": "both",
    "done": "both",
    "failed": "both"
  }
}
```

- `timeout`：弹窗自动消失秒数（5~60）
- `opacity`：弹窗不透明度（0.3~1.0）
- `messageMode`：弹窗内容模式，`response`=AI 回复前 50 字，`fixed`=固定完成文本
- `lang`：界面语言（`zh` / `en` / `ja` / `ko`）
- `muteUntil`：勿扰截止时间戳（毫秒），`null` 表示未开启勿扰；由弹窗勿扰按钮写入
- `titleStatus`：各状态在终端标签页的显示模式（`native` / `compat` / `both`）

配置可通过 `/notify` 命令修改并立即生效；直接编辑文件需重启 pi。非法配置值会自动回退默认。

## 测试

```bash
node --experimental-strip-types tests/tests.ts
```

57 个单元测试，覆盖内容提取、重试检测、通知状态机、标题组装与配置归一化。
