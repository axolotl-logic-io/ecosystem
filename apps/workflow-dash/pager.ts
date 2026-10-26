import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ViewHost } from "./selection.ts";
import { layout, panel, pill } from "./ui-format.ts";

const pageRows = 10;
const footerRows = 3;
interface PagerOptions {
  text: string;
  title: string;
  done: () => void;
  theme?: Theme;
}
class Pager implements Component {
  readonly scroll: ScrollView;
  private readonly host: ViewHost;
  private readonly options: PagerOptions;
  constructor(host: ViewHost, options: PagerOptions) {
    this.host = host;
    this.options = options;
    this.scroll = new ScrollView(new Text(options.text, 0, 0), {
      scrollbar: "hidden",
    });
  }
  invalidate(): void {
    this.scroll.invalidate();
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.done();
    } else if (matchesKey(data, Key.down)) {
      this.scroll.scrollBy(1);
    } else if (matchesKey(data, Key.up)) {
      this.scroll.scrollBy(-1);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scroll.scrollBy(pageRows);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scroll.scrollBy(-pageRows);
    } else if (matchesKey(data, Key.home)) {
      this.scroll.scrollToStart();
    } else if (matchesKey(data, Key.end)) {
      this.scroll.scrollToEnd();
    }
    this.host.requestRender();
  }
  render(width: number): string[] {
    const height = Math.max(footerRows, this.host.terminal.rows - footerRows);
    const lines = this.scroll.render(
      Math.max(1, width - layout.panelInset - layout.frameInset),
    );
    this.scroll.updateLayout(lines.length, height - layout.frameInset, () =>
      this.host.requestRender(),
    );
    const viewport = lines.slice(
      this.scroll.scrollTop,
      this.scroll.scrollTop + height - layout.frameInset,
    );
    const { theme } = this.options;
    if (theme === undefined) {
      return [
        this.options.title,
        ...viewport,
        "↑↓ PgUp/Dn Home/End · Esc back (data only)",
      ].map((line) => truncateToWidth(line, width));
    }
    return [
      ` ${pill(theme, { icon: "\uea62", text: this.options.title })}`,
      "",
      ...panel(theme, {
        title: "Read-only detail",
        content: viewport,
        width: width - layout.frameInset,
        height,
      }).map((line) => ` ${line}`),
      ` ${pill(theme, { icon: "Esc", text: "back", ink: "borderAccent" })} ${theme.fg("muted", "↑↓ PgUp/Dn Home/End · data only")}`,
    ].map((line) => truncateToWidth(line, width));
  }
}

export type { PagerOptions };
export { Pager };
