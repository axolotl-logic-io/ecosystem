import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  type KeyId,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { footer, header, listTitles, tabNames } from "./dashboard-frame.ts";
import type { Snapshot } from "./data.ts";
import type { Remote } from "./github.ts";
import {
  issueDetails,
  issueRow,
  subagentDetails,
  subagentRow,
} from "./item-view.ts";
import { jobDetailLines, jobListRow } from "./job-view.ts";
import { Navigation } from "./navigation.ts";
import {
  actionRunFacts,
  actionRunRow,
  buddyRunFacts,
  buddyRunRow,
  coverageFacts,
  coverageRow,
  factLines,
} from "./runtime-view.ts";
import type { Choice, Selection, ViewHost } from "./selection.ts";
import { type ChartScope, charts } from "./time-view.ts";
import { layout, pad, panel } from "./ui-format.ts";

const pageRows = 8;
const frame = {
  minimumHeight: 10,
  minimumBody: 4,
  footerRows: 3,
  narrowListMax: 10,
  narrowListMin: 5,
  narrowListFraction: 0.45,
  listFraction: 0.49,
};
const actionKeys: { key: KeyId; choice: Choice }[] = [
  { key: "g", choice: { kind: "global" } },
  { key: "t", choice: { kind: "tell" } },
  { key: "r", choice: { kind: "refresh" } },
  { key: "p", choice: { kind: "plan" } },
];
interface DashboardModel {
  theme: Theme;
  get: () => Snapshot;
  remote: Remote;
  getTime: () => string;
  done: (choice: Choice) => void;
}
function selectionRow(
  selection: Selection,
  theme: Theme,
  width: number,
): string {
  switch (selection.kind) {
    case "buddy-run":
      return buddyRunRow(selection.entry, theme);
    case "action-run":
      return actionRunRow(selection.entry, theme);
    case "coverage":
      return coverageRow(
        selection.state.runtime,
        selection.state.configWarnings,
        theme,
      );
    case "job":
      return jobListRow(selection.run, theme, width);
    case "issue":
      return issueRow(selection.item, theme);
    case "subagent":
      return subagentRow(selection.run, theme);
    default:
      return "";
  }
}
function sideBySide(left: string[], right: string[]): string[] {
  return left.map((line, index) => ` ${line} ${right[index] ?? ""}`);
}
class Dashboard implements Component {
  readonly navigation: Navigation;
  private detailOffset = 0;
  private readonly host: ViewHost;
  private readonly model: DashboardModel;
  constructor(host: ViewHost, model: DashboardModel) {
    this.host = host;
    this.model = model;
    this.navigation = new Navigation({
      ...model,
      changed: (): void => {
        this.detailOffset = 0;
      },
    });
  }
  invalidate(): void {
    this.navigation.invalidate();
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.model.done(undefined);
      return;
    }
    const action = actionKeys.find(({ key }) => matchesKey(data, key));
    if (action !== undefined) {
      this.model.done(action.choice);
    } else if (matchesKey(data, "a")) {
      this.model.done({ kind: "action", selection: this.navigation.selected });
    } else if (matchesKey(data, Key.pageDown)) {
      this.detailOffset += pageRows;
    } else if (matchesKey(data, Key.pageUp)) {
      this.detailOffset = Math.max(0, this.detailOffset - pageRows);
    } else {
      this.navigation.handleInput(data);
    }
    this.host.requestRender();
  }
  private rows(width: number): string[] {
    return this.navigation.items.map((item) => {
      const selected = item.value === this.navigation.value;
      let prefix = " ";
      if (selected) {
        prefix = "›";
      }
      const line = pad(
        `${prefix} ${selectionRow(item.selection, this.model.theme, width)}`,
        width,
      );
      if (selected) {
        return this.model.theme.fg("accent", line);
      }
      return line;
    });
  }
  private details(width: number): string[] {
    const { theme, remote } = this.model;
    const selection = this.navigation.selected;
    if (selection === undefined) {
      let message = "◷ Nothing selected";
      if (remote.inflight !== undefined) {
        message = "◷ Loading read-only data…";
      }
      return [
        theme.fg("muted", message),
        ...remote.errors.map((error) => theme.fg("error", error)),
      ];
    }
    switch (selection.kind) {
      case "buddy-run":
        return factLines(buddyRunFacts(selection.entry), theme, width);
      case "action-run":
        return factLines(actionRunFacts(selection.entry), theme, width);
      case "coverage":
        return factLines(
          coverageFacts(
            selection.state.runtime,
            selection.state.configWarnings,
          ),
          theme,
          width,
        );
      case "job":
        return jobDetailLines(selection.run, theme, width);
      case "issue":
        return [
          ...issueDetails(selection.item, theme, width),
          ...remote.errors.map((error) => theme.fg("error", error)),
        ];
      case "subagent":
        return subagentDetails(selection.run, theme, width);
      default:
        return [];
    }
  }
  private scroll(lines: string[], height: number): string[] {
    this.detailOffset = Math.min(
      this.detailOffset,
      Math.max(0, lines.length - height + layout.frameInset),
    );
    return lines.slice(this.detailOffset);
  }
  private chart(width: number, scope: ChartScope): string[] {
    return charts(
      this.model.theme,
      {
        runs: this.model.get().jobHistory,
        sessions: this.model.getTime(),
        scope,
      },
      width,
    );
  }
  private timePanels(width: number, height: number): string[] {
    const { theme } = this.model;
    if (width < layout.wide) {
      return panel(theme, {
        title: "Time / today",
        content: this.scroll(
          this.chart(
            Math.max(1, width - layout.panelInset - layout.frameInset),
            "all",
          ),
          height,
        ),
        width: width - layout.frameInset,
        height,
      }).map((line) => ` ${line}`);
    }
    const leftWidth = Math.floor((width - layout.gutter) / 2);
    const rightWidth = width - layout.gutter - leftWidth;
    const left = this.chart(leftWidth - layout.panelInset, "launches");
    const right = this.chart(rightWidth - layout.panelInset, "types");
    this.detailOffset = Math.min(
      this.detailOffset,
      Math.max(
        0,
        Math.max(left.length, right.length) - height + layout.frameInset,
      ),
    );
    return sideBySide(
      panel(theme, {
        title: "Historical job launch time / today",
        content: left.slice(this.detailOffset),
        width: leftWidth,
        height,
      }),
      panel(theme, {
        title: "Historical job stages / sessions",
        content: right.slice(this.detailOffset),
        width: rightWidth,
        height,
      }),
    );
  }
  private listPanel(width: number, height: number): string[] {
    const { items } = this.navigation;
    const selected = Math.max(
      0,
      items.findIndex((item) => item.value === this.navigation.value),
    );
    const start = Math.max(0, selected - (height - frame.footerRows));
    let content = this.rows(Math.max(1, width - layout.panelInset)).slice(
      start,
    );
    let count = 0;
    if (items.length > 0) {
      count = selected + 1;
    }
    if (content.length === 0) {
      let text = "◷ No items observed";
      if (this.model.remote.inflight !== undefined) {
        text = "◷ Loading…";
      }
      content = [this.model.theme.fg("muted", text)];
    }
    return panel(this.model.theme, {
      title: `${listTitles.at(this.navigation.tab) ?? "Items"} · ${count}/${items.length}`,
      content,
      width,
      height,
    });
  }
  private itemPanels(width: number, height: number): string[] {
    let listWidth = width - layout.frameInset;
    let listHeight = Math.min(
      frame.narrowListMax,
      Math.max(
        frame.narrowListMin,
        Math.floor(height * frame.narrowListFraction),
      ),
    );
    let detailHeight = height - listHeight;
    const wide = width >= layout.wide;
    if (wide) {
      listWidth = Math.floor((width - layout.gutter) * frame.listFraction);
      listHeight = height;
      detailHeight = height;
    }
    let detailWidth = listWidth;
    if (wide) {
      detailWidth = width - layout.gutter - listWidth;
    }
    const list = this.listPanel(listWidth, listHeight);
    const detail = panel(this.model.theme, {
      title: "Detail",
      content: this.scroll(
        this.details(Math.max(1, detailWidth - layout.panelInset)),
        detailHeight,
      ),
      width: detailWidth,
      height: detailHeight,
    });
    if (wide) {
      return sideBySide(list, detail);
    }
    return [...list, ...detail].map((line) => ` ${line}`);
  }
  render(width: number): string[] {
    const state = this.model.get();
    this.navigation.refresh();
    const heading = header(this.model.theme, state, this.navigation.tab, width);
    const height = Math.max(frame.minimumHeight, this.host.terminal.rows);
    const contentHeight = Math.max(
      frame.minimumBody,
      height - heading.length - frame.footerRows,
    );
    let body: string[];
    if (this.navigation.tab === tabNames.length - 1) {
      body = this.timePanels(width, contentHeight);
    } else {
      body = this.itemPanels(width, contentHeight);
    }
    return [...heading, ...body, ...footer(this.model.theme, state)]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width));
  }
}

export type { DashboardModel };
export { Dashboard };
