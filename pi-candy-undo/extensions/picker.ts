/**
 * 自定义选择器：输入过滤 + ←/→ 翻页 + ↑/↓ 选择（与 toolbox 的 transcript-jump
 * 选择器同款交互，参考其 JumpDialog 实现）。
 *
 * 替换 pi 原生 ctx.ui.select：原生实现（ExtensionSelectorComponent）把全部选项
 * 无滚动地一次性渲染，选项超过一屏时部分选项无法显示/选择。本组件只负责 UI，
 * 选项文案（1-based 序号、60 字符截断、改动统计）仍由 src/commands.ts 生成。
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
} from "@earendil-works/pi-tui";

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

/** 单页最大条数（与 toolbox 选择器一致）。 */
const PAGE_SIZE = 12;

/** 选择器：与 pi 原生 select 同款外观（边框 + 粗体标题 + 底部按键提示）。 */
export class PickerDialog extends Container implements Focusable {
  private readonly searchInput = new Input();
  private readonly allItems: SelectItem[];
  private list: SelectList;
  private filteredItems: SelectItem[];
  private currentIndex = 0;
  private readonly listSlot: number;
  private readonly pageSize: number;
  private readonly onPick: (option: string) => void;
  private readonly onClose: () => void;
  private _focused = false;

  /** 原始选项（不受过滤影响；entry 集成测试用它运行选择谓词）。 */
  readonly options: readonly string[];

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value; // IME 光标定位需要把焦点传给内嵌输入框
  }

  constructor(
    title: string,
    options: string[],
    hint: string,
    theme: Theme,
    onPick: (option: string) => void,
    onClose: () => void,
  ) {
    super();
    this.options = options;
    const items: SelectItem[] = options.map((option) => ({ value: option, label: option }));
    this.allItems = items;
    this.filteredItems = items;
    this.pageSize = Math.min(PAGE_SIZE, Math.max(1, items.length));
    this.onPick = onPick;
    this.onClose = onClose;

    // 与 pi 原生 select（ExtensionSelectorComponent）同款外观：边框 + 粗体标题 + 底部按键提示
    this.addChild(new BorderLine((text) => theme.fg("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listSlot = this.children.length;
    this.list = this.buildList(items);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", hint), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new BorderLine((text) => theme.fg("border", text)));
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.pageSize, getSelectListTheme(), {
      minPrimaryColumnWidth: 10,
      maxPrimaryColumnWidth: 72,
      // 按显示宽度截断（含 CJK/emoji 宽度），超宽加省略号——文案本身已做字符截断，这里兜底窄终端
      truncatePrimary: (ctx) => truncateToWidth(ctx.text, ctx.maxWidth, "…"),
    });
    list.onSelectionChange = (item) => {
      this.currentIndex = this.filteredItems.indexOf(item);
    };
    list.onSelect = (item) => this.onPick(item.value);
    list.onCancel = () => this.onClose();
    return list;
  }

  private applyFilter(query: string): void {
    const q = query.trim().toLowerCase();
    this.filteredItems = q ? this.allItems.filter((item) => fuzzyMatch(q, item.label).matches) : this.allItems;
    this.currentIndex = 0;
    this.list = this.buildList(this.filteredItems);
    this.children[this.listSlot] = this.list;
  }

  private page(delta: number): void {
    const max = Math.max(0, this.filteredItems.length - 1);
    const next = Math.min(max, Math.max(0, this.currentIndex + delta * this.pageSize));
    this.list.setSelectedIndex(next);
    this.currentIndex = next;
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

/** 弹出选择器；取消（Esc）返回 undefined。 */
export async function pickFromList(
  ui: ExtensionUIContext,
  title: string,
  options: string[],
  hint: string,
): Promise<string | undefined> {
  const picked = await ui.custom<string | null>((_tui, theme, _keybindings, done) => {
    const dialog = new PickerDialog(title, options, hint, theme, (option) => done(option), () => done(null));
    return dialog;
  });
  return picked ?? undefined;
}
