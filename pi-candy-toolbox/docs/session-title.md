# session-title — 会话标题生成工具

> 工具 id：`session-title` ｜ 命令：`/candy-title [提示词]`

## 功能

为当前 pi 会话生成/重新生成标题。标题显示在会话选择器（Ctrl+R）、`/resume` 列表，以及 win-notify 的终端标签页标题中。

## 命令用法

```
/candy-title              标准生成
/candy-title 英文标题     生成时追加「用户附加要求：英文标题」
/candy-title 更简洁       生成时追加「用户附加要求：更简洁」
/candy-title config       查看当前生效配置
/candy-title config mode local   修改配置（见下表）
```

> ⚠️ **`config` 为保留字**：生成提示词请勿以 `config` 开头，否则会被当作配置子命令。

- 已有标题时覆盖，并提示 `「旧标题」→「新标题」`
- 生成结果通过系统通知展示；失败（会话为空等）会提示原因
- **生成中反馈**：执行期间显示 spinner 动画 + footer 状态文字「正在生成会话标题…」，结束后自动清除（无论成功/失败）
- **配置修改立即生效并持久化**，支持 Tab 自动补全：

| 配置子命令 | 说明 |
|---|---|
| `/candy-title config` | 查看当前生效配置 |
| `/candy-title config mode <llm\|local>` | 生成模式 |
| `/candy-title config maxLength <1~50>` | 标题字符上限 |
| `/candy-title config sampleChars <50~2000>` | 每段采样字符数 |
| `/candy-title config autoFirst <true\|false>` | 首次对话自动生成 |
| `/candy-title config model <provider/modelId>` | 指定生成模型 |
| `/candy-title config model none` | 清除 model，回退当前会话模型 |

输入非法值时提示合法范围，不修改配置；修改写入 `candy-toolbox.json` 并同步到内存，无需重启。

## 配置项

配置位于 `~/.pi/agent/candy-toolbox.json`：

```json
{
  "session-title": {
    "mode": "llm",
    "maxLength": 20,
    "sampleChars": 200,
    "autoFirst": true,
    "model": "openrouter/deepseek-chat"
  }
}
```

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `mode` | `"llm"` | 生成模式：`llm` 用模型生成（失败自动回退 `local`）；`local` 零 token 本地截断 |
| `maxLength` | `20` | 标题字符上限（中文字符） |
| `sampleChars` | `200` | 每段消息采样字符数 |
| `autoFirst` | `true` | 首次对话结束自动生成（仅当会话尚无标题时触发） |
| `model` | 当前会话模型 | 指定生成标题用的模型（`provider/modelId` 格式，如 `openrouter/deepseek-chat`）。可配置一个小而便宜的模型专用于标题这类小任务，更快更省；配置的模型不可用时自动回退当前会话模型，再失败回退 `local` |

## 方案逻辑

### 采样策略：四点采样，成本与会话长度无关

标题只需要"这段对话在做什么"。用整个上下文生成既昂贵（成本随会话长度线性膨胀）又低质（工具调用、长代码等噪音干扰概括）。因此只取四段，每段截断 `sampleChars`：

| 段落 | 截断 | 语义 |
|------|------|------|
| 首条 user | 头部 | 任务陈述（主题） |
| 首条 assistant | 头部 | 任务理解 |
| 末条 user | 头部 | 当前方向 |
| 末条 assistant | 尾部 | 当前进展（assistant 结论通常在尾部） |

- 输入恒定 ≈ 300~500 tokens；只有单条消息时自动省略重复段落
- 输出预算：`maxTokens = maxLength × 2 + 20`（与配置联动：中文 1 字 ≤2 token 的保守估计 + 缓冲，不截断标题同时保留成本上限）、`temperature ≈ 0.3`，system prompt 要求 ≤ `maxLength` 字一行输出

### 双模式与回退链

```
/candy-title
   └─ 采样全空（空会话/提取不到文本）？
        ├─ 是 → 不调模型，直接返回空 → 提示「会话为空」
        └─ 否 → mode: llm？
                 ├─ 是 → 静默调用模型（modelRegistry.complete，不产生会话消息）
                 │        └─ 失败/无模型/超时(30s) → 回退 local
                 └─ 否 → local：首条可用消息清洗截断（去 @引用/控制字符、折叠空白）
```

LLM 失败时通知文案会注明「已用本地模式」，命令永不空手而归。

> ⚠️ 采样全空时**必须**短路：空 prompt 下模型只能靠标题指令硬编，实测 deepseek 会凭空产出无关主题的「像样标题」（如「2024年高考作文题汇总」），反而覆盖掉本应出现的「会话为空」提示。

### 与 win-notify 的联动

win-notify 的终端标签页标题格式为 `状态图标 会话名 - 目录名 [pi@id]`，其中：

- **会话名段**：win-notify 每次组装标题时实时读取 `getSessionName()`，并监听 `session_info_changed`——本工具 `setSessionName()` 后其标题**自动跟随刷新**，无冲突
- **`[pi@id]` 段**：进程唯一标识，独立拼接，不受会话名影响——win-notify 弹窗"继续"按钮的多窗口定位功能不受影响

## 实现要点

- 单文件 `extensions/tools/session-title.ts`，零额外依赖（pi-ai 类型用局部结构子集，不引入 package.json 依赖）
- 核心纯函数（可单测）：`extractSamples` / `buildPrompt` / `cleanText` / `cleanupTitle` / `generateTitleLocal` / `generateTitle`
- 命令 handler 与 `autoFirst` 共用 `generateTitle` 主流程
- 30 秒流超时保护，防止命令卡死
