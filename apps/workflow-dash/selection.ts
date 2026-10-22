import type { BuddyRun } from "./buddy-runs.ts";
import type { Snapshot } from "./data.ts";
import type { GitHubItem, Remote } from "./github.ts";
import { today } from "./time.ts";
import type { WorkflowRun } from "./workflow-source.ts";
import { workflowRunLabel } from "./workflow-view.ts";

type Selection =
  | { kind: "workflow"; run: WorkflowRun }
  | { kind: "issue"; item: GitHubItem }
  | { kind: "buddy"; run: BuddyRun };
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
  | { kind: "detail"; item: WorkflowRun }
  | { kind: "refresh" }
  | { kind: "plan" }
  | undefined;
interface ViewHost {
  terminal: { rows: number };
  requestRender: () => void;
}

function entries(tab: number, state: Snapshot, remote: Remote): Entry[] {
  if (tab === 0) {
    return [...state.workflowRuns]
      .filter(
        (run) =>
          run.live !== false ||
          today(run.data.startedAt) ||
          today(run.data.endedAt),
      )
      .sort((a, b) => Number(b.live) - Number(a.live))
      .map((run) => ({
        value: `${run.repo}#${run.issue}/${run.data.id ?? "current"}`,
        label: workflowRunLabel(run),
        selection: { kind: "workflow", run },
      }));
  }
  if (tab === 1) {
    return [
      ...remote.issues,
      ...remote.prs.map((item) => ({ ...item, isPr: true })),
    ].map((item) => ({
      value: `${item.isPr === true}#${item.repo}#${item.number}`,
      label: item.title,
      selection: { kind: "issue", item },
    }));
  }
  if (tab === 2) {
    return state.buddyRuns.map((run) => ({
      value: run.id,
      label: run.mission,
      selection: { kind: "buddy", run },
    }));
  }
  return [];
}
function drill(selection: Selection | undefined): Choice {
  if (selection?.kind === "workflow") {
    return { kind: "detail", item: selection.run };
  }
  if (selection?.kind === "issue" && selection.item.isPr !== true) {
    return { kind: "thread", item: selection.item };
  }
  return undefined;
}

export type { Choice, Entry, Selection, ViewHost };
export { drill, entries };
