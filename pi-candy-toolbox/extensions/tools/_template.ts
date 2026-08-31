/**
 * 新工具模板
 *
 * 新增一个工具的三步：
 *   1. 复制本文件为 extensions/tools/<tool-id>.ts（简单工具）或
 *      extensions/tools/<tool-id>/index.ts（复杂工具）
 *   2. 改 id、description、defaultConfig，实现 register()
 *   3. 在 extensions/index.ts 的工具清单 TOOLS 中 import 并加入数组
 *
 * 两种形态（渐进式）：
 *   - 简单工具：单文件，复制本模板即可
 *   - 复杂工具：升级为目录（目录名 = 工具 id），目录内可放私有子模块、
 *     资源文件（如 .ps1 / .json）、tests/ 测试；index.ts 是唯一的对外
 *     入口，仍导出 ToolDefinition，接口与单文件完全一致
 *
 * 配置约定（详见 core/config.ts）：
 *   ~/.pi/agent/candy-toolbox.json 中 "tool-id": true / false / { 配置 }
 *
 * 注意：
 *   - register 只在工具启用时被调用，无需自己判断开关
 *   - 默认配置不要写死敏感信息；需要用户填写的项给合理默认值
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../core/config";

/** 本工具的独立配置项（对应配置文件中 "my-tool" key 下的字段） */
export interface MyToolConfig {
  /** 示例配置项 */
  someOption: string;
}

const tool: ToolDefinition<MyToolConfig> = {
  id: "my-tool",
  description: "一句话说明这个工具是干什么的",
  defaultConfig: { someOption: "default value" },
  // defaultEnabled: false, // 默认关闭的工具取消这行注释
  register(pi: ExtensionAPI, config: MyToolConfig): void {
    // 在这里注册命令 / 工具 / 事件监听……
    void config;
    void pi;
    // pi.registerCommand("my-tool", { ... });
    // pi.registerTool({ ... });
    // pi.on("session_start", async (_e, ctx) => { ... });
  },
};

export default tool;
