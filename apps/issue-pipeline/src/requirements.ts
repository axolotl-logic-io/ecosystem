// Requirements come from trusted issue input. Only issues that used Author
// additionally require its current authenticated Gherkin comment. Missing mode
// markers parse as authored, preserving saved work from older runtimes.

import type { GherkinComment } from "./gherkin-comment.ts";
import type { IssueState } from "./state.ts";

function usedAuthor(state: IssueState): boolean {
  return (
    state.authorUsed ||
    state.gherkin !== null ||
    state.stage === "author" ||
    state.stoppedStage === "author"
  );
}

function requirementsStage(state: IssueState): "author" | "implement" {
  if (usedAuthor(state)) {
    return "author";
  }
  return "implement";
}

function requirementsHold(
  state: IssueState,
  gherkin: Pick<GherkinComment, "inputs"> | null,
  inputs: string,
): boolean {
  if (usedAuthor(state)) {
    return gherkin !== null && gherkin.inputs === inputs;
  }
  return state.requirementsInputs === inputs;
}

// No receipt or merged fact is erased to revisit requirements. Exact revision
// guards invalidate earlier approval/clearance; they never authorize a writer
// over merged work or a security rejection.
function requirementsState(
  state: IssueState,
  resumeStage: "implement" | "review",
): IssueState {
  if (usedAuthor(state)) {
    return {
      ...state,
      stage: "author",
      authorUsed: true,
      resumeStage,
      hardened: null,
      integration: null,
    };
  }
  return {
    ...state,
    stage: "implement",
    resumeStage: null,
    hardened: null,
    integration: null,
  };
}

export { requirementsHold, requirementsStage, requirementsState, usedAuthor };
