/**
 * tools/hello.ts：示例工具（命令注册 + greeting 配置）
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCtx, makeLogger, makePiStub } from "./helpers.ts";
import { useTempAgentDir } from "./helpers.ts";

useTempAgentDir();
const { default: hello } = await import("../extensions/tools/hello.ts");

test("register creates /candy-hello", () => {
  const stub = makePiStub();
  hello.register(stub.pi, { greeting: "hi" }, makeLogger().log);

  const command = stub.commands.get("candy-hello");
  assert.ok(command);
  assert.equal(command.description, "candy-toolbox 示例：打个招呼");
});

test("handler notifies with the configured greeting", async () => {
  const stub = makePiStub();
  hello.register(stub.pi, { greeting: "custom greeting" }, makeLogger().log);

  const { ctx, notices } = makeCtx();
  await stub.commands.get("candy-hello")?.handler("", ctx);

  assert.deepEqual(notices, [{ message: "custom greeting", type: "info" }]);
});

test("default config ships a greeting", () => {
  assert.equal(typeof hello.defaultConfig.greeting, "string");
  assert.equal(hello.defaultEnabled, false);
});
