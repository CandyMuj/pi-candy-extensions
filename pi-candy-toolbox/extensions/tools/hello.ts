/**
 * 示例工具：/candy-hello
 *
 * 演示一个最小工具的结构：id + 默认配置 + register。
 * 新增真实工具时请复制 _template.ts 并对照修改。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../core/config";

export interface HelloConfig {
  /** 打招呼的内容 */
  greeting: string;
}

const tool: ToolDefinition<HelloConfig> = {
  id: "hello",
  description: "示例工具：注册 /candy-hello 命令",
  defaultEnabled: false, // 示例工具默认关闭
  defaultConfig: { greeting: "你好，我是 candy-toolbox 🍬" },
  register(pi: ExtensionAPI, config: HelloConfig): void {
    pi.registerCommand("candy-hello", {
      description: "candy-toolbox 示例：打个招呼",
      handler: async (_args, ctx) => {
        ctx.ui.notify(config.greeting, "info");
      },
    });
  },
};

export default tool;
