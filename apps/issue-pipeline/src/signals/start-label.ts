// A completed start's label is display, not its durable acceptance or spent
// attempt. Remove only the application that caused this task, after its
// determined result is confirmed. A newer application belongs to its caller.
import type { Config } from "../config.ts";
import type { QualifiedSignal, TaskId } from "../domain.ts";
import { gh } from "../github.ts";
import { labelEvidence, START_LABELS } from "./label-evidence.ts";
import { signalId } from "./records.ts";

// Returns a cleanup failure for the action's warning log; never changes its
// result. Every call reads the current application before one DELETE. A lost
// response is not retried: a later application must get its own fresh check.
function clearCompletedStart(
  cfg: Config,
  signal: QualifiedSignal,
  task: TaskId,
): string | null {
  if (signal.kind !== "start" || signal.task !== task) {
    return null;
  }
  const entry = [...START_LABELS].find(([, requested]) => requested === task);
  if (entry === undefined) {
    return null;
  }
  const [label] = entry;
  try {
    const evidence = labelEvidence(cfg, signal.workItem.number);
    if (evidence.status !== "ok") {
      return `could not read ${label}'s current application`;
    }
    const event = evidence.value.get(label);
    if (event === null) {
      return `${label}'s current application is unexplained`;
    }
    if (
      event === undefined ||
      signalId(signal.workItem, event.id) !== signal.id
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
        `repos/${cfg.repo}/issues/${signal.workItem.number}/labels/${encodeURIComponent(label)}`,
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
