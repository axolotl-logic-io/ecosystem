// Requirements come from trusted issue input. Only issues that used Author
// additionally require its current authenticated Gherkin comment. Missing mode
// markers parse as authored, preserving saved work from older runtimes.

import type { GherkinComment } from "./gherkin-comment.ts";
import type { IssueState } from "./state.ts";

const DEVELOPER_RECOVERY_REASON =
  "work has merged or attempted-merge evidence; explicit reconciliation is required, not another Developer session";

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

function developerRecoveryRequired(state: IssueState): boolean {
  return (
    state.codeMerged !== null ||
    state.merged !== null ||
    state.mergeAttempt !== null
  );
}

// Null refuses a direct requirements writer over retained merge
// evidence. Callers stop or hold without changing that evidence. Legacy
// authored requirements retain their existing return path.
function requirementsState(
  state: IssueState,
  resumeStage: "implement" | "review",
): IssueState | null {
  if (!usedAuthor(state) && developerRecoveryRequired(state)) {
    return null;
  }
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

export {
  DEVELOPER_RECOVERY_REASON,
  developerRecoveryRequired,
  requirementsHold,
  requirementsStage,
  requirementsState,
  usedAuthor,
};
