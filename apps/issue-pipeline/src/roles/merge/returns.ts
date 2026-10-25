// Where the merge job sends an issue it doesn't land. A changed input goes
// to its requirements owner, and a code head that moved, a failed check or a
// missing Hardening result goes back to review for fresh Hardening.

import type { RoleEnd } from "../../job/role-context.ts";
import {
  DEVELOPER_RECOVERY_REASON,
  requirementsStage,
  requirementsState,
} from "../../requirements.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

// The state with its landing authorization voided: no hardening or
// integration of an earlier revision holds for the next one.
function voided(state: IssueState): IssueState {
  return { ...state, hardened: null, verifiedSha: null };
}

function toRequirements(state: IssueState, why: string): RoleEnd {
  const next = requirementsState({ ...state, verifiedSha: null }, "review");
  if (next === null) {
    return failed(state, `${why}; ${DEVELOPER_RECOVERY_REASON}`);
  }
  return {
    kind: "next",
    state: logged(
      { ...next, integration: state.integration },
      `${why}; back to ${requirementsStage(state)}`,
    ),
  };
}

function toReview(state: IssueState, why: string): RoleEnd {
  const next: IssueState = { ...voided(state), stage: "review" };
  return { kind: "next", state: logged(next, `${why}; back to review`) };
}

function failed(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "error", reason, state };
}

function waiting(state: IssueState, reason: string): RoleEnd {
  return { kind: "wait", reason, state };
}

export { failed, logged, toRequirements, toReview, waiting };
