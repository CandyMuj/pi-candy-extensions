/**
 * pi-candy-toolbox — 小工具聚合箱入口
 *
 * 职责：加载配置 → 按工具清单逐个归一化开关/配置 → 启用者调用 register。
 *
 * 新增工具三步：
 *   1. 复制 extensions/tools/_template.ts 为 tools/<tool-id>.ts 并实现
 *   2. 在本文件 TOOLS 清单中 import 并加入数组（一行）
 *   3. 可选：在 ~/.pi/agent/candy-toolbox.json 中用工具 id 配置开关
 *
 * 日志：全部写文件（见 core/log.ts），不打印终端。开关判定：
 *   该工具是否写日志 = $toolbox.debug || 工具配置.debug === true
 *   插件自身（$toolbox.log）由 $toolbox.debug 控制（错误也走同一开关）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLBOX_KEY, loadRawConfig, resolveTool, resolveToolboxConfig } from "./core/config.ts";
import type { ToolDefinition } from "./core/config.ts";
import { createLogger } from "./core/log.ts";
import hello from "./tools/hello.ts";
import sessionTitle from "./tools/session-title.ts";
import clickCursor from "./tools/click-cursor.ts";
import transcriptJump from "./tools/transcript-jump.ts";

/** 工具清单：新增工具在此登记（目录工具 import 后加一行，例如：myTool,） */
const TOOLS: ToolDefinition<object>[] = [
  hello,
  sessionTitle,
  clickCursor,
  transcriptJump,
  // import 后在此加一行，例如：myTool,（目录工具写 import myTool from "./tools/my-tool"，
  // jiti 会自动解析目录下的 index.ts）
];

export default function (pi: ExtensionAPI): void {
  const raw = loadRawConfig();
  const toolbox = resolveToolboxConfig(raw);
  // 插件自身日志（$toolbox.log，id 直接用保留 key，与配置同名且排序靠前）：
  // 启动摘要、禁用/启用、注册失败都由 $toolbox.debug 控制
  const log = createLogger(TOOLBOX_KEY, toolbox.debug);
  let enabledCount = 0;

  log(`加载开始（logDir=${toolbox.logDir}）`);

  for (const tool of TOOLS) {
    const { enabled, config } = resolveTool(tool, raw[tool.id]);
    if (!enabled) {
      log(`${tool.id}: 已禁用`);
      continue;
    }
    enabledCount++;
    // 工具级 debug 与插件级 debug 是「或」关系：任一为 true，该工具就写自己的 <tool-id>.log
    const toolLog = createLogger(tool.id, toolbox.debug || (config as { debug?: unknown }).debug === true);
    try {
      tool.register(pi, config, toolLog);
      log(`${tool.id}: 已启用`);
    } catch (e) {
      log(`${tool.id}: 注册失败`, e);
      console.error(`[candy-toolbox] ${tool.id}: 注册失败`, e);
    }
  }

  log(`加载完成：${enabledCount}/${TOOLS.length} 个工具启用`);
}
