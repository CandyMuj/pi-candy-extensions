# pi-win-notify

A Windows notification tool for [pi](https://pi.dev) — fast focus, response preview, elapsed time, mute, multi-language. Pops up a dark popup when pi finishes, so you never miss a completed task. Skips automatically when the terminal is focused.

> 中文说明见 [README.zh.md](./README.zh.md)

## Install

```bash
pi install npm:pi-win-notify
```

Or from GitHub:

```bash
pi install git:https://github.com/ryanchan720/pi-desktop-notify.git
```

## Usage

| Command | Description |
|---------|-------------|
| `/notify` | Toggle on/off |
| `/notify on` / `off` | Force state |
| `/notify timeout 15` | Auto-dismiss seconds (5~60, default 15) |
| `/notify opacity 1.0` | Window opacity (0.3~1.0) |
| `/notify message fixed` | Fixed completion text |
| `/notify message response` | AI reply first 50 chars (default) |
| `/notify lang en` | Language: `zh` `en` `ja` `ko` |
| `/notify status` | Daemon health + current config |

## Features

- ⚡ **Fast focus** — click or **Alt+]** to switch back to terminal. **Alt+[** to dismiss
- 👁 **Response preview** — shows AI reply (first 50 chars) right in the popup, or fixed text
- ⏱ **Elapsed time** — displays how long the task took
- 🔕 **Mute** — 3 min / 30 min / 1 hour / off. Persists to disk, survives restarts. Multi-instance auto-sync
- 🌐 **Multi-language** — `zh` / `en` / `ja` / `ko`
- 🪟 Dark rounded popup, bottom-right, follows cursor across monitors
- 🔝 Top-most, never steals focus, configurable opacity, auto-dismiss
- 🤖 Auto-suppress during LLM retries & context compaction
- 📝 Title = first 25 chars of user prompt
- 📚 Multi-pi window stacking

## Test

```bash
node --experimental-strip-types tests/tests.ts
```

42 unit tests covering content extraction, retry detection, and state machine.
