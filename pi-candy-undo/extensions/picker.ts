/**
 * 自定义选择器：输入过滤 + ←/→ 翻页 + ↑/↓ 选择（与 toolbox 的 transcript-jump
 * 选择器同款交互，参考其 JumpDialog 实现）。
 *
 * 替换 pi 原生 ctx.ui.select：原生实现（ExtensionSelectorComponent）把全部选项
 * 无滚动地一次性渲染，选项超过一屏时部分选项无法显示/选择。
 *
 * 两种模式：
 * - 纯文本模式（pickFromList）：选项原样展示，无序号/统计；
 * - 统计模式（pickMessageFromList）：选项 = 序号 + 文本 + 异步统计后缀。统计
 *   不阻塞打开：先显示占位（计算中…），按页在后台计算（可见页优先、预载下一页），
 *   算完重建列表并 requestRender 刷新，选中返回条目 id。
 */

import { getSelectListTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  fuzzyMatch,
  getKeybindings,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** 结构化选项：id 为选中回调的返回值；text 为原始文案（统计模式会补序号与统计后缀）。 */
export interface PickerItem {
  id: string;
  text: string;
}

/** 单页最大条数：SelectList 一屏可显示数，同时用作异步统计的计算批次（先算可见页，再预载下一页）。 */
const PAGE_SIZE = 12;
/** 统计并发数：页内并行、避免瞬时文件 IO 风暴。 */
const STATS_CONCURRENCY = 4;
/** 条目文本最大显示宽度（与 toolbox transcript-jump 的预览保护一致，统一算法与取值）。 */
const PICKER_TEXT_MAX_WIDTH = 400;

/** 横向分隔线（宽度自适应；颜色显式传入）。 */
class BorderLine {
  private color: (text: string) => string;

  constructor(color: (text: string) => string) {
    this.color = color;
  }

  invalidate(): void {
    // 无缓存状态
  }

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

import { truncateDisplay } from "../src/text.ts";

interface PickerDialogOptions {
  title: string;
  items: readonly PickerItem[];
  hint: string;
  theme: Theme;
  onPick: (id: string) => void;
  onClose: () => void;
  requestRender: () => void;
  /** 逐项统计文案（异步）；缺省为纯文本模式（无序号、无后缀） */
  statsFor?: (id: string) => Promise<string>;
  /** 统计未完成时的占位文案（仅统计模式使用） */
  computingLabel?: string;
  /** 初始选中项下标（重开时保持上次选择） */
  initialIndex?: number;
}

/** 选择器：与 pi 原生 select 同款外观（边框 + 粗体标题 + 底部按键提示）。 */
export class PickerDialog extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly items: readonly PickerItem[];
  private readonly statsFor: ((id: string) => Promise<string>) | undefined;
  private readonly computingLabel: string;
  private readonly requestRender: () => void;
  private readonly onPick: (id: string) => void;
  private readonly onClose: () => void;
  private readonly listSlot: number;
  private readonly pageSize: number;

  private allItems: SelectItem[];
  private filteredItems: SelectItem[];
  private list: SelectList;
  private currentIndex = 0;
  private query = "";
  private _focused = false;
  private closed = false;

  // 异步统计调度：suffixById[id] = 已算好的统计文案；pending 为未算 id 队列
  private readonly suffixById = new Map<string, string>();
  private readonly doneIds = new Set<string>();
  private readonly metaById = new Map<string, { ordinal: number; text: string }>();
  private pending: string[] = [];
  private computing = 0;

  /** 纯文本模式的原始选项（entry 集成测试用它运行选择谓词）。 */
  readonly options: readonly string[];
  /** 结构化选项（统计模式下测试用文本谓词选择并取 id）。 */
  readonly pickerItems: readonly PickerItem[];

  /** 当前过滤后的标签（测试用：观察统计异步填充进度）。 */
  get labels(): string[] {
    return this.filteredItems.map((item) => item.label);
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value; // IME 光标定位需要把焦点传给内嵌输入框
  }

  constructor(opts: PickerDialogOptions) {
    super();
    this.items = opts.items;
    this.statsFor = opts.statsFor;
    this.computingLabel = opts.computingLabel ?? "";
    this.requestRender = opts.requestRender;
    this.onPick = opts.onPick;
    this.onClose = opts.onClose;
    this.pickerItems = opts.items;
    this.items.forEach((item, index) => this.metaById.set(item.id, { ordinal: index + 1, text: item.text }));
    this.options = this.items.map((item) => this.labelFor(item, this.items.indexOf(item) + 1));
    this.pageSize = Math.min(PAGE_SIZE, Math.max(1, this.items.length));

    // 与 pi 原生 select（ExtensionSelectorComponent）同款外观：边框 + 粗体标题 + 底部按键提示
    this.addChild(new BorderLine((text) => opts.theme.fg("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(opts.theme.fg("accent", opts.theme.bold(opts.title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listSlot = this.children.length;
    this.allItems = this.buildItems();
    this.filteredItems = this.allItems;
    this.list = this.buildList(this.filteredItems);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(opts.theme.fg("dim", opts.hint), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new BorderLine((text) => opts.theme.fg("border", text)));

    // 初始选中项（重开时保持上次选择）；SelectList.setSelectedIndex 不触发 onSelectionChange，
    // 需同步设置 currentIndex，否则统计刷新（refreshList）会把它重置回第一条
    const initial = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, this.filteredItems.length - 1));
    this.currentIndex = initial;
    this.list.setSelectedIndex(initial);

    if (this.statsFor) {
      this.pending = this.items.map((item) => item.id);
      this.kick(); // 立即开算可见页，不等首次渲染
    }
  }

  /** 关闭后停止统计调度（组件即将销毁，避免对已卸载组件 requestRender）。 */
  markClosed(): void {
    this.closed = true;
  }

  /** 标签 = 序号 + 60 字符截断文本 + 统计后缀；纯文本模式直接原样展示。 */
  private labelFor(item: PickerItem, ordinal: number): string {
    if (!this.statsFor) {
      return item.text;
    }
    const suffix = this.suffixById.get(item.id) ?? this.computingLabel;
    const base = `${ordinal}. ${truncateDisplay(item.text, PICKER_TEXT_MAX_WIDTH)}`;
    return suffix ? `${base} · ${suffix}` : base;
  }

  private buildItems(): SelectItem[] {
    return this.items.map((item, index) => ({ value: item.id, label: this.labelFor(item, index + 1) }));
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.pageSize, getSelectListTheme(), {
      minPrimaryColumnWidth: 10,
      maxPrimaryColumnWidth: 72,
      // 按显示宽度截断（含 CJK/emoji 宽度），超宽加省略号——文案本身已做字符截断，这里兜底窄终端
      // 统计模式补充：先扣除「序号前缀 + 统计后缀」宽度再截主文本，保证统计完整可见（主内容让位、附加内容保底）
      truncatePrimary: (ctx) => this.truncateRow(ctx),
    });
    list.onSelectionChange = (item) => {
      this.currentIndex = this.filteredItems.indexOf(item);
    };
    list.onSelect = (item) => this.onPick(item.value);
    list.onCancel = () => this.onClose();
    return list;
  }

  /** 当前统计文案：已算好用结果，未算好用占位；纯文本模式无统计。 */
  private statsPartFor(id: string): string | undefined {
    if (!this.statsFor) {
      return undefined;
    }
    const suffix = this.suffixById.get(id) ?? this.computingLabel;
    return suffix || undefined;
  }

  /** 行截断：统计模式只截「序号 + 主文本 · 统计」中的主文本；其余模式整行按宽度截断。 */
  private truncateRow(ctx: { text: string; maxWidth: number; item: { value: string } }): string {
    const meta = this.metaById.get(ctx.item.value);
    const stats = this.statsPartFor(ctx.item.value);
    if (!meta || !stats) {
      return truncateToWidth(ctx.text, ctx.maxWidth, "…");
    }
    const suffix = ` · ${stats}`;
    const head = `${meta.ordinal}. `;
    const textMax = Math.max(1, ctx.maxWidth - visibleWidth(head) - visibleWidth(suffix));
    return head + truncateDisplay(meta.text, Math.min(textMax, PICKER_TEXT_MAX_WIDTH)) + suffix;
  }

  /** 统计到达后重建标签并刷新列表（保留当前选中项与过滤词）。 */
  private refreshList(): void {
    this.allItems = this.buildItems();
    this.filteredItems = this.query
      ? this.allItems.filter((item) => fuzzyMatch(this.query, item.label).matches)
      : this.allItems;
    this.currentIndex = Math.min(this.currentIndex, Math.max(0, this.filteredItems.length - 1));
    this.list = this.buildList(this.filteredItems);
    this.children[this.listSlot] = this.list;
    this.list.setSelectedIndex(this.currentIndex);
  }

  private applyFilter(query: string): void {
    this.query = query.trim().toLowerCase();
    this.currentIndex = 0;
    this.filteredItems = this.query
      ? this.allItems.filter((item) => fuzzyMatch(this.query, item.label).matches)
      : this.allItems;
    this.list = this.buildList(this.filteredItems);
    this.children[this.listSlot] = this.list;
    this.kick(); // 过滤后可见页变化，重排计算队列
  }

  private page(delta: number): void {
    const max = Math.max(0, this.filteredItems.length - 1);
    const next = Math.min(max, Math.max(0, this.currentIndex + delta * this.pageSize));
    this.list.setSelectedIndex(next);
    this.currentIndex = next;
    this.kick(); // 翻页后把新可见页提到计算队列头
  }

  /** 把可见页（含下一页预载）移到队列头，其余保持原顺序。 */
  private reprioritize(): void {
    if (!this.statsFor) {
      return;
    }
    const end = this.currentIndex + this.pageSize * 2; // 可见页 + 预载下一页
    const priority: string[] = [];
    const seen = new Set<string>();
    for (let i = this.currentIndex; i < end && i < this.filteredItems.length; i += 1) {
      const id = this.filteredItems[i]?.value;
      if (id !== undefined && this.pending.includes(id)) {
        priority.push(id);
        seen.add(id);
      }
    }
    for (const id of this.pending) {
      if (!seen.has(id)) {
        priority.push(id);
      }
    }
    this.pending = priority;
  }

  /** 以受限并发持续计算队列头的统计。 */
  private kick(): void {
    if (!this.statsFor || this.closed) {
      return;
    }
    this.reprioritize();
    while (this.computing < STATS_CONCURRENCY && this.pending.length > 0) {
      const id = this.pending.shift();
      if (id === undefined || this.doneIds.has(id)) {
        continue;
      }
      this.computing += 1;
      void this.computeOne(id);
    }
  }

  private async computeOne(id: string): Promise<void> {
    try {
      const suffix = await this.statsFor?.(id);
      this.suffixById.set(id, suffix ?? "");
    } catch {
      this.suffixById.set(id, ""); // 单项失败只留空后缀，不影响其余项
    }
    this.doneIds.add(id);
    this.computing -= 1;
    if (!this.closed) {
      this.refreshList();
      this.requestRender();
      this.kick();
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
      return;
    }
    if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.pageUp")) {
      this.page(-1);
      return;
    }
    if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.pageDown")) {
      this.page(1);
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }
}

async function pickItems(
  ui: ExtensionUIContext,
  title: string,
  items: readonly PickerItem[],
  hint: string,
  computingLabel: string | undefined,
  statsFor: ((id: string) => Promise<string>) | undefined,
  initialIndex = 0,
): Promise<string | undefined> {
  const picked = await ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const requestRender = () => {
      const t = tui as { requestRender?: () => void };
      t.requestRender?.();
    };
    let dialog: PickerDialog | undefined;
    dialog = new PickerDialog({
      title,
      items,
      hint,
      theme,
      computingLabel,
      statsFor,
      initialIndex,
      requestRender,
      onPick: (id) => {
        dialog?.markClosed();
        done(id);
      },
      onClose: () => {
        dialog?.markClosed();
        done(null);
      },
    });
    return dialog;
  });
  return picked ?? undefined;
}

/** 弹出选择器（纯文本模式）；取消（Esc）返回 undefined。 */
export async function pickFromList(
  ui: ExtensionUIContext,
  title: string,
  options: string[],
  hint: string,
): Promise<string | undefined> {
  const items = options.map((option) => ({ id: option, text: option }));
  return pickItems(ui, title, items, hint, undefined, undefined);
}

/** 弹出带异步统计的选择器：立即打开、按页计算统计并动态刷新；取消返回 undefined，选中返回条目 id。 */
export async function pickMessageFromList(
  ui: ExtensionUIContext,
  title: string,
  items: readonly PickerItem[],
  hint: string,
  computingLabel: string,
  statsFor: (id: string) => Promise<string>,
  initialIndex = 0,
): Promise<string | undefined> {
  return pickItems(ui, title, items, hint, computingLabel, statsFor, initialIndex);
}
