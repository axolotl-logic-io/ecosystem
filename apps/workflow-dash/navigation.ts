import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList } from "@earendil-works/pi-tui";
import { tabNames } from "./dashboard-frame.ts";
import type { Snapshot } from "./data.ts";
import type { Remote } from "./github.ts";
import {
  type Choice,
  drill,
  type Entry,
  entries,
  type Selection,
} from "./selection.ts";

const visibleRows = 8;
interface NavigationModel {
  theme: Theme;
  get: () => Snapshot;
  remote: Remote;
  done: (choice: Choice) => void;
  changed: () => void;
}
/** Own source-key selection across refreshes and pane changes. */
class Navigation {
  tab = 0;
  private list: SelectList;
  private entries: Entry[] = [];
  private version: Snapshot | undefined;
  private issuesVersion: Remote["issues"] | undefined;
  private prsVersion: Remote["prs"] | undefined;
  private readonly model: NavigationModel;
  constructor(model: NavigationModel) {
    this.model = model;
    this.list = this.buildList();
  }
  get items(): readonly Entry[] {
    return this.entries;
  }
  get value(): string | undefined {
    return this.list.getSelectedItem()?.value;
  }
  get selected(): Selection | undefined {
    return this.entries.find((entry) => entry.value === this.value)?.selection;
  }
  invalidate(): void {
    this.version = undefined;
  }
  rebuild(): void {
    this.list = this.buildList(this.value);
  }
  refresh(): void {
    const state = this.model.get();
    const { remote } = this.model;
    if (
      state !== this.version ||
      remote.issues !== this.issuesVersion ||
      remote.prs !== this.prsVersion
    ) {
      this.version = state;
      this.issuesVersion = remote.issues;
      this.prsVersion = remote.prs;
      this.rebuild();
    }
  }
  private buildList(current?: string): SelectList {
    this.entries = entries(this.tab, this.model.get(), this.model.remote);
    const { theme } = this.model;
    let options: { value: string; label: string }[] = this.entries;
    if (options.length === 0) {
      options = [{ value: "", label: "No items" }];
    }
    const list = new SelectList(options, visibleRows, {
      selectedPrefix: (text: string): string => theme.fg("accent", text),
      selectedText: (text: string): string => theme.fg("accent", text),
      description: (text: string): string => theme.fg("muted", text),
      scrollInfo: (text: string): string => theme.fg("dim", text),
      noMatch: (text: string): string => text,
    });
    const index = this.entries.findIndex((entry) => entry.value === current);
    if (index >= 0) {
      list.setSelectedIndex(index);
    }
    list.onSelectionChange = this.model.changed;
    list.onSelect = (): void => {
      const selected = this.entries.find(
        (entry) => entry.value === list.getSelectedItem()?.value,
      )?.selection;
      const choice = drill(selected);
      if (choice !== undefined) {
        this.model.done(choice);
      }
    };
    this.model.changed();
    return list;
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      let direction = 1;
      if (matchesKey(data, Key.shift("tab"))) {
        direction = tabNames.length - 1;
      }
      this.tab = (this.tab + direction) % tabNames.length;
      this.rebuild();
    } else {
      this.list.handleInput(data);
    }
  }
}

export type { NavigationModel };
export { Navigation };
