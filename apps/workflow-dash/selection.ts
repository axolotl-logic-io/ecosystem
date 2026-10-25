import type { Snapshot } from "./data.ts";
import type { GitHubItem, Remote } from "./github.ts";
import type { HistoricalJob } from "./job-history.ts";
import { jobLabel } from "./job-view.ts";
import type { ActionRunEntry, BuddyRunEntry } from "./runtime-runs.ts";
import {
  actionRunFacts,
  buddyRunFacts,
  coverageFacts,
} from "./runtime-view.ts";
import type { SubagentRun } from "./subagent-runs.ts";
import { today } from "./time.ts";

/** Pane order; the Time pane is last. */
const panes = [
  "buddy-runs",
  "action-runs",
  "issues",
  "subagent-runs",
  "job-history",
  "time",
] as const;
type Selection =
  | { kind: "buddy-run"; entry: BuddyRunEntry }
  | { kind: "action-run"; entry: ActionRunEntry }
  | { kind: "coverage"; state: Snapshot }
  | { kind: "issue"; item: GitHubItem }
  | { kind: "subagent"; run: SubagentRun }
  | { kind: "job"; run: HistoricalJob };
interface Entry {
  value: string;
  label: string;
  selection: Selection;
}
type Choice =
  | { kind: "action"; selection?: Selection }
  | { kind: "global" }
  | { kind: "tell" }
  | { kind: "thread"; item: GitHubItem }
  | { kind: "detail"; item: HistoricalJob }
  | { kind: "observation"; title: string; text: string }
  | { kind: "refresh" }
  | { kind: "plan" }
  | undefined;
interface ViewHost {
  terminal: { rows: number };
  requestRender: () => void;
}

function coverageEntry(state: Snapshot): Entry {
  return {
    value: "coverage",
    label: "Coverage",
    selection: { kind: "coverage", state },
  };
}
function jobEntries(state: Snapshot): Entry[] {
  return [...state.jobHistory]
    .filter(
      (run) =>
        run.live !== false ||
        today(run.data.startedAt) ||
        today(run.data.endedAt),
    )
    .sort((a, b) => Number(b.live) - Number(a.live))
    .map((run) => ({
      value: `${run.repo}#${run.issue}/${run.data.id ?? "current"}`,
      label: jobLabel(run),
      selection: { kind: "job", run },
    }));
}
function entries(tab: number, state: Snapshot, remote: Remote): Entry[] {
  switch (panes[tab]) {
    case "buddy-runs":
      return [
        ...state.runtime.buddyRuns.map(
          (entry): Entry => ({
            value: entry.run.id,
            label: entry.run.buddy.name,
            selection: { kind: "buddy-run", entry },
          }),
        ),
        coverageEntry(state),
      ];
    case "action-runs":
      return [
        ...state.runtime.actionRuns.map(
          (entry): Entry => ({
            value: entry.run.id,
            label: `${entry.run.workItem.repo}#${entry.run.workItem.number} ${entry.run.task}`,
            selection: { kind: "action-run", entry },
          }),
        ),
        coverageEntry(state),
      ];
    case "issues":
      return [
        ...remote.issues,
        ...remote.prs.map((item) => ({ ...item, isPr: true })),
      ].map((item) => ({
        value: `${item.isPr === true}#${item.repo}#${item.number}`,
        label: item.title,
        selection: { kind: "issue", item },
      }));
    case "subagent-runs":
      return state.subagentRuns.map((run) => ({
        value: run.id,
        label: run.mission,
        selection: { kind: "subagent", run },
      }));
    case "job-history":
      return jobEntries(state);
    default:
      return [];
  }
}
function observationText(facts: string[], value: unknown): string {
  return [
    ...facts,
    "",
    "RECORDED OBSERVATION · data only",
    JSON.stringify(value, null, 2),
  ].join("\n");
}
function drill(selection: Selection | undefined): Choice {
  switch (selection?.kind) {
    case "job":
      return { kind: "detail", item: selection.run };
    case "issue":
      if (selection.item.isPr === true) {
        return undefined;
      }
      return { kind: "thread", item: selection.item };
    case "buddy-run":
      return {
        kind: "observation",
        title: `Buddy run ${selection.entry.run.id}`,
        text: observationText(
          buddyRunFacts(selection.entry),
          selection.entry.run,
        ),
      };
    case "action-run":
      return {
        kind: "observation",
        title: `Action run ${selection.entry.run.id}`,
        text: observationText(
          actionRunFacts(selection.entry),
          selection.entry.run,
        ),
      };
    case "coverage":
      return {
        kind: "observation",
        title: "Observation coverage",
        text: coverageFacts(
          selection.state.runtime,
          selection.state.configWarnings,
        ).join("\n"),
      };
    default:
      return undefined;
  }
}

export type { Choice, Entry, Selection, ViewHost };
export { drill, entries, panes };
