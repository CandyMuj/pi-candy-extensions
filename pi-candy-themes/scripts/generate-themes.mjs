// Generates the four Selenized theme files from the canonical palette data.
// Run with: node scripts/generate-themes.mjs
//
// Palette source: https://github.com/jan-warchol/selenized (terminal configs).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(__dirname, "..", "themes");

const SCHEMA =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

// Canonical Selenized palette (16 ANSI colors from the terminal configs,
// plus the GUI-only orange/violet accents from the vim colortemplates).
const variants = {
  "candy-selenized-black": {
    bg0: "#181818", bg1: "#252525", bg2: "#3b3b3b",
    dim0: "#777777", fg0: "#b9b9b9", fg1: "#dedede",
    red: "#ed4a46", green: "#70b433", yellow: "#dbb32d",
    blue: "#368aeb", magenta: "#eb6eb7", cyan: "#3fc5b7",
    orange: "#e67f43", violet: "#a580e2",
    brRed: "#ff5e56", brGreen: "#83c746", brYellow: "#efc541",
    brBlue: "#4f9cfe", brMagenta: "#ff81ca", brCyan: "#56d8c9",
    brOrange: "#fa9153", brViolet: "#b891f5",
  },
  "candy-selenized-dark": {
    bg0: "#103c48", bg1: "#184956", bg2: "#2d5b69",
    dim0: "#72898f", fg0: "#adbcbc", fg1: "#cad8d9",
    red: "#fa5750", green: "#75b938", yellow: "#dbb32d",
    blue: "#4695f7", magenta: "#f275be", cyan: "#41c7b9",
    orange: "#ed8649", violet: "#af88eb",
    brRed: "#ff665c", brGreen: "#84c747", brYellow: "#ebc13d",
    brBlue: "#58a3ff", brMagenta: "#ff84cd", brCyan: "#53d6c7",
    brOrange: "#fd9456", brViolet: "#bd96fa",
  },
  "candy-selenized-light": {
    bg0: "#fbf3db", bg1: "#ece3cc", bg2: "#d5cdb6",
    dim0: "#909995", fg0: "#53676d", fg1: "#3a4d53",
    red: "#d2212d", green: "#489100", yellow: "#ad8900",
    blue: "#0072d4", magenta: "#ca4898", cyan: "#009c8f",
    orange: "#c25d1e", violet: "#8762c6",
    brRed: "#cc1729", brGreen: "#428b00", brYellow: "#a78300",
    brBlue: "#006dce", brMagenta: "#c44392", brCyan: "#00978a",
    brOrange: "#bc5819", brViolet: "#825dc0",
  },
  "candy-selenized-white": {
    bg0: "#ffffff", bg1: "#ebebeb", bg2: "#cdcdcd",
    dim0: "#878787", fg0: "#474747", fg1: "#282828",
    red: "#d6000c", green: "#1d9700", yellow: "#c49700",
    blue: "#0064e4", magenta: "#dd0f9d", cyan: "#00ad9c",
    orange: "#d04a00", violet: "#7f51d6",
    brRed: "#bf0000", brGreen: "#008400", brYellow: "#af8500",
    brBlue: "#0054cf", brMagenta: "#c7008b", brCyan: "#009a8a",
    brOrange: "#ba3700", brViolet: "#6b40c3",
  },
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex([r, g, b]) {
  const c = (n) => Math.round(n).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Blend `ratio` of `color` into `base` (12% gives a subtle tinted background).
function tint(base, color, ratio = 0.12) {
  const b = hexToRgb(base);
  const c = hexToRgb(color);
  return rgbToHex(b.map((v, i) => v + (c[i] - v) * ratio));
}

// Midpoint between two colors (used for the tertiary "dim" text gray).
function mid(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => (v + y[i]) / 2));
}

function buildTheme(name, p) {
  return {
    $schema: SCHEMA,
    name,
    vars: {
      bg0: p.bg0,
      bg1: p.bg1,
      bg2: p.bg2,
      dim0: p.dim0,
      fg0: p.fg0,
      fg1: p.fg1,
      dimGray: mid(p.dim0, p.bg2),
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.magenta,
      cyan: p.cyan,
      orange: p.orange,
      violet: p.violet,
      brRed: p.brRed,
      brGreen: p.brGreen,
      brYellow: p.brYellow,
      brBlue: p.brBlue,
      brMagenta: p.brMagenta,
      brCyan: p.brCyan,
      brOrange: p.brOrange,
      brViolet: p.brViolet,
    },
    colors: {
      accent: "blue",
      border: "bg2",
      borderAccent: "brBlue",
      borderMuted: "bg1",
      success: "green",
      error: "red",
      warning: "yellow",
      muted: "dim0",
      dim: "dimGray",
      text: "fg0",
      thinkingText: "dim0",

      selectedBg: "bg2",
      scrollbarThumb: "bg2",
      searchMatchBg: "bg2",
      searchMatchText: "fg0",
      userMessageBg: "bg1",
      userMessageText: "fg0",
      customMessageBg: "bg2",
      customMessageText: "fg0",
      customMessageLabel: "violet",
      toolPendingBg: tint(p.bg1, p.blue),
      toolSuccessBg: tint(p.bg1, p.green),
      toolErrorBg: tint(p.bg1, p.red),
      toolTitle: "fg0",
      toolOutput: "dim0",

      mdHeading: "orange",
      mdLink: "blue",
      mdLinkUrl: "dim0",
      mdCode: "cyan",
      mdCodeBlock: "fg0",
      mdCodeBlockBorder: "bg2",
      mdQuote: "dim0",
      mdQuoteBorder: "bg2",
      mdHr: "bg2",
      mdListBullet: "cyan",

      toolDiffAdded: "green",
      toolDiffRemoved: "red",
      toolDiffContext: "dim0",

      syntaxComment: "dim0",
      syntaxKeyword: "brYellow",
      syntaxFunction: "brBlue",
      syntaxVariable: "blue",
      syntaxString: "cyan",
      syntaxNumber: "brCyan",
      syntaxType: "green",
      syntaxOperator: "yellow",
      syntaxPunctuation: "dim0",

      thinkingOff: "bg2",
      thinkingMinimal: "dim0",
      thinkingLow: "blue",
      thinkingMedium: "cyan",
      thinkingHigh: "violet",
      thinkingXhigh: "magenta",
      thinkingMax: "red",

      bashMode: "green",
    },
    export: {
      pageBg: p.bg0,
      cardBg: p.bg1,
      infoBg: p.bg2,
    },
  };
}

mkdirSync(THEMES_DIR, { recursive: true });
for (const [name, palette] of Object.entries(variants)) {
  const theme = buildTheme(name, palette);
  const file = join(THEMES_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(theme, null, 2) + "\n");
  console.log(`wrote ${file}`);
}
