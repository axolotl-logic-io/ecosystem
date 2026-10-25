import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Snapshot } from "./data.ts";
import { statusSegments } from "./status-view.ts";
import { chip, layout, pill } from "./ui-format.ts";

const tabNames = [
  "Buddy runs",
  "Action runs",
  "Issues",
  "Subagent runs",
  "Job history",
  "Time",
];
const listTitles = [
  "Buddy runs",
  "Action runs",
  "Issues / PRs",
  "Subagent runs",
  "Job history · historical records",
];
function tabBar(theme: Theme, tab: number, width: number): string {
  return tabNames
    .map((name, index) => {
      if (index === tab && width < layout.narrow) {
        return chip(theme, name, "accent");
      }
      if (index === tab) {
        return pill(theme, { icon: String(index + 1), text: name });
      }
      if (width < layout.narrow) {
        return theme.fg("muted", ` ${index + 1} `);
      }
      return theme.fg("muted", `  ${index + 1} ${name}  `);
    })
    .join(" ");
}
function header(
  theme: Theme,
  state: Snapshot,
  tab: number,
  width: number,
): string[] {
  const rows: string[] = [];
  for (const segment of statusSegments(state, theme, width < layout.wide)) {
    const last = rows.at(-1);
    if (
      last !== undefined &&
      visibleWidth(`${last} ${segment}`) <= width - layout.frameInset
    ) {
      rows[rows.length - 1] = `${last} ${segment}`;
    } else {
      rows.push(segment);
    }
  }
  return [
    ` ${pill(theme, { icon: "\u{f06a9}", text: "WORKFLOWS" })}  ${theme.fg("muted", "Autumn / work overview · read-only")}`,
    ...rows.map((line) => ` ${line}`),
    "",
    ` ${tabBar(theme, tab, width)}`,
    "",
  ];
}
function footer(theme: Theme, state: Snapshot): string[] {
  const hints = [
    { icon: "Tab", text: "panes" },
    { icon: "↑↓", text: "select" },
    { icon: "Enter", text: "drill" },
    { icon: "PgUp/Dn", text: "scroll" },
    { icon: "Esc", text: "back" },
  ];
  const actions = [
    { key: "a", label: "actions" },
    { key: "g", label: "global" },
    { key: "t", label: "tell" },
    { key: "r", label: "refresh" },
    { key: "p", label: "plan · all instructions editable" },
  ];
  return [
    ` ${theme.fg("dim", `Plan mtime ${state.planMtime} · 15s local / 2m GitHub cache`)}`,
    ` ${hints.map((hint) => pill(theme, { ...hint, ink: "borderAccent", muted: true })).join(" ")}`,
    ` ${actions.map((action) => theme.fg("accent", action.key) + theme.fg("muted", ` ${action.label}`)).join("   ")}`,
  ];
}

export { footer, header, listTitles, tabNames };
