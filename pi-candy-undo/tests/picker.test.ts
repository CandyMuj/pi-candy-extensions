/**
 * extensions/picker.ts：选择器的异步统计调度（打开不阻塞、可见页优先、动态刷新）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PickerDialog } from "../extensions/picker.ts";

const themeStub = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_name: string, text: string) => text,
} as never;

/** 有延迟的统计计算：记录计算顺序，验证可见页 + 预载页优先。 */
function makeStatsFor(order: string[], latencyMs: number): (id: string) => Promise<string> {
  return (id: string) =>
    new Promise((resolve) => {
      setTimeout(() => {
        order.push(id);
        resolve(`s-${id}`);
      }, latencyMs);
    });
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("picker opens instantly with placeholders and fills stats in the background", async () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, text: `msg ${i}` }));
  const order: string[] = [];
  const statsFor = makeStatsFor(order, 5);
  let renders = 0;
  const dialog = new PickerDialog({
    title: "t",
    items,
    hint: "h",
    theme: themeStub,
    onPick: () => {},
    onClose: () => {},
    requestRender: () => {
      renders += 1;
    },
    computingLabel: "计算中…",
    statsFor,
  });

  // 构造即返回（不阻塞等待统计），首屏标签带占位
  assert.ok(dialog.labels[0]?.includes("计算中…"), "未算完的条目显示占位");
  assert.ok(dialog.labels[0]?.includes("msg 0"), "文本立即可见");
  assert.equal(order.length, 0, "统计异步进行，构造时尚未完成");

  // 等待全部算完：标签逐一替换为统计后缀，每次完成都请求重绘
  await waitUntil(() => dialog.labels.every((label) => !label.includes("计算中…")), 5000);
  assert.ok(dialog.labels[0]?.endsWith("s-m0"), "首条统计填充完成");
  assert.ok(dialog.labels[24]?.endsWith("s-m24"), "末条统计填充完成");
  assert.ok(renders >= 25, "每次统计完成都触发重绘");

  // 计算顺序 = 原顺序分页推进（可见页 12 条 + 预载下一页 12 条在前，其余殿后）
  assert.deepEqual(order.slice(0, 24), items.slice(0, 24).map((item) => item.id), "前两页（可见 + 预载）先算");
  assert.deepEqual(order.slice(24), ["m24"], "超出预载窗口的殿后");
});

test("picker fills stats lazily for a page beyond the prefetch window", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, text: `msg ${i}` }));
  const order: string[] = [];
  const statsFor = makeStatsFor(order, 5);
  const dialog = new PickerDialog({
    title: "t",
    items,
    hint: "h",
    theme: themeStub,
    onPick: () => {},
    onClose: () => {},
    requestRender: () => {},
    computingLabel: "计算中…",
    statsFor,
  });
  assert.equal(dialog.labels.length, 30);

  // 前两页（24 条）算完后，剩余条目继续在后台补算，无需翻页触发
  await waitUntil(() => order.length >= items.length, 5000);
  assert.equal(order.length, 30, "后台持续补算全部条目（翻页无需等待）");
});

test("plain mode keeps raw labels and computes nothing", async () => {
  const items = ["Restore code (2 files)", "Restore conversation"];
  const dialog = new PickerDialog({
    title: "t",
    items: items.map((option) => ({ id: option, text: option })),
    hint: "h",
    theme: themeStub,
    onPick: () => {},
    onClose: () => {},
    requestRender: () => {},
  });
  assert.deepEqual(dialog.labels, items, "纯文本模式原样展示");
  assert.deepEqual([...dialog.options], items, "options 保持原选项");
});
