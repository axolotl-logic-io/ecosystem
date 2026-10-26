import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Snapshot } from "./data.ts";
import { pendingRequest } from "./item-view.ts";
import { buddyRunRow, partialCoverage } from "./runtime-view.ts";
import { type Badge, pill } from "./ui-format.ts";

const unavailableVersion = /unknown|unavailable/u;
const shortShaLength = 7;
const widgetRunRows = 4;
function versionBadge(state: Snapshot, short: boolean): Badge {
  const known = !unavailableVersion.test(state.main + state.installed);
  const equal = known && state.main === state.installed;
  let comparison = `/ ${state.main.slice(0, shortShaLength)}`;
  if (equal) {
    comparison = "= main";
  } else if (short && known) {
    comparison = "≠ main";
  } else if (short) {
    comparison = "? main";
  }
  let text = `${state.installed.slice(0, shortShaLength)} ${comparison}`;
  if (known && !equal && !short) {
    text += " · differs";
  }
  if (equal) {
    return { icon: "\ue0a0", text, ink: "success" };
  }
  return { icon: "\ue0a0", text, ink: "warning" };
}
function webBadge(state: Snapshot): Badge {
  const web = state.pbWeb ?? [];
  let text = "pb-web not observed";
  if (web.length > 0) {
    text = `pb-web busy #${web.join(",#")}`;
  } else if (state.pbWebBusy === true) {
    text = "pb-web busy";
  }
  if (web.length > 0 || state.pbWebBusy === true) {
    return { icon: "\u{f059f}", text, ink: "warning" };
  }
  return { icon: "\u{f059f}", text, ink: "muted" };
}
/** Counts of buddy-run conditions; none of them is a health claim. */
function runtimeBadge(state: Snapshot, compact: boolean): Badge {
  const { buddyRuns } = state.runtime;
  function count(condition: string): number {
    return buddyRuns.filter((entry) => entry.condition.state === condition)
      .length;
  }
  const uncertain = count("stale") + count("unknown");
  const partial = partialCoverage(state.runtime);
  let text = `buddy runs ${count("process-observed")} process-observed · ${uncertain} stale/unknown`;
  if (compact) {
    text = `buddy ${count("process-observed")} · ? ${uncertain}`;
  }
  if (partial) {
    text += " · coverage partial";
  }
  if (uncertain > 0 || partial) {
    return { icon: "\u{f035b}", text, ink: "warning" };
  }
  return { icon: "\u{f035b}", text, ink: "borderAccent" };
}
function statusSegments(
  state: Snapshot,
  theme: Theme,
  compact = false,
  shortVersion = false,
): string[] {
  let hold: Badge = { icon: "●", text: "HOLD NOT OBSERVED", ink: "success" };
  if (state.hold) {
    hold = { icon: "✗", text: "HOLD", ink: "error" };
  }
  const badges: Badge[] = [
    hold,
    runtimeBadge(state, compact),
    webBadge(state),
    versionBadge(state, shortVersion),
  ];
  const pending = state.subagentRuns.filter(pendingRequest).length;
  if (pending > 0) {
    badges.push({
      icon: "◷",
      text: `${pending} subagent requests`,
      ink: "warning",
    });
  }
  return badges.map((badge) => pill(theme, badge));
}
function statusPills(state: Snapshot, theme: Theme, compact = false): string {
  return statusSegments(state, theme, compact).join(" ");
}
function widget(get: () => Snapshot, theme: Theme): Component {
  return {
    invalidate(): void {
      // The stateless view recomputes data and theme colors on every render.
    },
    render(width: number): string[] {
      const state = get();
      const runs = state.runtime.buddyRuns.filter(
        (entry) =>
          entry.condition.state !== "stopped" &&
          entry.condition.state !== "ended",
      );
      let status = statusPills(state, theme, true);
      if (visibleWidth(status) > width) {
        status = statusSegments(state, theme, true, true).join(" ");
      }
      const lines = [
        status,
        ...runs
          .slice(0, widgetRunRows)
          .map((entry) => buddyRunRow(entry, theme)),
      ];
      if (runs.length === 0) {
        lines.push(
          theme.fg(
            "muted",
            state.error ??
              "◷ No running buddy run recorded · /dash for coverage",
          ),
        );
      }
      return lines.map((line) => truncateToWidth(line, width));
    },
  };
}

export { statusPills, statusSegments, widget };
