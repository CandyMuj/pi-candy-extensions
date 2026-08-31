/**
 * pi-candy-toolbox — 小工具聚合箱入口
 *
 * 职责：加载配置 → 按工具清单逐个归一化开关/配置 → 启用者调用 register。
 *
 * 新增工具三步：
 *   1. 复制 extensions/tools/_template.ts 为 tools/<tool-id>.ts 并实现
 *   2. 在本文件 TOOLS 清单中 import 并加入数组（一行）
 *   3. 可选：在 ~/.pi/agent/candy-toolbox.json 中用工具 id 配置开关
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRawConfig, resolveTool } from "./core/config";
import type { ToolDefinition } from "./core/config";
import hello from "./tools/hello";

/** 工具清单：新增工具在此登记（目录工具 import 后加一行，例如：myTool,） */
const TOOLS: ToolDefinition[] = [
  hello,
  // import 后在此加一行，例如：myTool,（目录工具写 import myTool from "./tools/my-tool"，
  // jiti 会自动解析目录下的 index.ts）
];

export default function (pi: ExtensionAPI): void {
  const raw = loadRawConfig();
  let enabledCount = 0;

  for (const tool of TOOLS) {
    const { enabled, config } = resolveTool(tool, raw[tool.id]);
    if (!enabled) {
      console.log(`[candy-toolbox] ${tool.id}: 已禁用`);
      continue;
    }
    enabledCount++;
    try {
      tool.register(pi, config);
      console.log(`[candy-toolbox] ${tool.id}: 已启用`);
    } catch (e) {
      console.error(`[candy-toolbox] ${tool.id}: 注册失败`, e);
    }
  }

  console.log(`[candy-toolbox] 加载完成：${enabledCount}/${TOOLS.length} 个工具启用`);
}
