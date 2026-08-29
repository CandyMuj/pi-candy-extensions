# pi-win-notify

[pi](https://pi.dev) 桌面通知工具 — 快速聚焦、回复预览、耗时显示、勿扰、多语言。pi 完成时右下角弹出暗色窗口，切走也不错过。终端在前台时自动跳过。

> For English, see [README.md](./README.md)

## 安装

```bash
pi install npm:pi-win-notify
```

或从 GitHub：

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
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
| `/notify lang en` | 语言：`zh` `en` `ja` `ko` |
| `/notify status` | 守护进程状态 + 当前配置 |

## 特性

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

## 测试

```bash
node --experimental-strip-types tests/tests.ts
```

42 个单元测试，覆盖内容提取、重试检测和状态机。
