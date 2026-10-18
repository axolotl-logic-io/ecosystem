// What the review rounds' tasks read of their context and of the issue, so
// a stage gives its own context and state and a role gives just these.

import type { IssueState } from "../types.ts";
import type { StageContext, StageState } from "./types.ts";

// What the fixer's and re-reviewers' tasks read: a stage's context or the
// implementor's fix entry's (#418), and the issue with its spec.
type TaskContext = Pick<StageContext, "cfg" | "budgets" | "committer">;
interface TaskItem {
  n: number;
  paths: StageState["paths"];
  st: Pick<StageState["st"], "spec" | "specFile" | "resolvedHistory">;
}

// What a review's task reads of its context and of the issue: the repo
// config, and the issue's number, paths and spec. A stage gives its own
// context and state; the reviewer role gives just these (#421).
type ReviewTaskContext = Pick<TaskContext, "cfg">;
type ReviewTaskItem = Pick<TaskItem, "n" | "paths"> & {
  st: Pick<IssueState, "spec" | "specFile">;
};

export type { ReviewTaskContext, ReviewTaskItem, TaskContext, TaskItem };
