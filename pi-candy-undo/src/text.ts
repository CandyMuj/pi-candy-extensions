/**
 * 展示文本处理：折叠为单行并按显示宽度截断（CJK/emoji 显示宽度感知，不破半字）。
 *
 * 与 pi-candy-toolbox（extensions/tools/transcript-jump.ts）的 truncateDisplay
 * 是跨包的两份逐字相同实现——修改本文件时必须同步另一份。
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

export function truncateDisplay(text: string, maxWidth: number): string {
  return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxWidth, "…");
}
