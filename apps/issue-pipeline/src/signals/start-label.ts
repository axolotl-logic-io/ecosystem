// A completed start's label is display, not its durable acceptance or spent
// attempt. Remove only the application that caused this task, after its
// determined result is confirmed. A newer application belongs to its caller.
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import type { TaskId, WorkItemRef } from "../domain.ts";
import { gh } from "../github.ts";
import { determined, readRecords } from "../tasks/records.ts";
import { labelEvidence, START_LABELS } from "./label-evidence.ts";
import { signalId } from "./records.ts";

// Returns a cleanup failure for the action's warning log; never changes its
// result. Every call reads the current application before one DELETE. A lost
// response is not retried: a later application must get its own fresh check.
function clearCompletedStart(
  cfg: Config,
  workItem: WorkItemRef,
  task: TaskId,
  run: string | null,
): string | null {
  const entry = [...START_LABELS].find(([, requested]) => requested === task);
  if (entry === undefined) {
    return null;
  }
  const [label] = entry;
  try {
    if (run === null) {
      return "the completed task's original run is unknown";
    }
    const { rows } = readRecords(
      cfg,
      workItem.number,
      listComments(cfg, workItem.number),
    );
    const result = determined(rows, run);
    if (result === undefined || result.binding.task !== task) {
      return "the completed task's result is not confirmed";
    }
    const evidence = labelEvidence(cfg, workItem.number);
    if (evidence.status !== "ok") {
      return `could not read ${label}'s current application`;
    }
    const event = evidence.value.get(label);
    if (event === null) {
      return `${label}'s current application is unexplained`;
    }
    if (
      event === undefined ||
      signalId(workItem, event.id) !== result.cause.signal
    ) {
      return null;
    }
    gh(
      cfg,
      "landing",
      [
        "api",
        "-X",
        "DELETE",
        `repos/${cfg.repo}/issues/${workItem.number}/labels/${encodeURIComponent(label)}`,
      ],
      { reconciles: true },
    );
    return null;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

export { clearCompletedStart };
