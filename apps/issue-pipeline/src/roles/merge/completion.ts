// Complete only after read-only confirmation of pre-Land checks and bound
// pre-Land Security clearance (#185). Missing or stale clearance stops; no
// Security is acquired after Land. Save done before finish so cleanup can be
// replayed.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { legacyWikiOf } from "../../land-provenance.ts";
import { ownLandResultObservation } from "../../ops/land-guard.ts";
import { requirementsHold } from "../../requirements.ts";
import { securityRefusal } from "../../security-clearance.ts";
import type { CodeLanded, IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import type { Step } from "../writer-session.ts";
import { ended } from "../writer-session.ts";
import { confirmedLandedResult, NO_POST_LAND_REPAIR } from "./checks.ts";
import { failed, logged, toRequirements } from "./returns.ts";
import { rejectedAgain } from "./security.ts";

const FINISHED = z.union([
  z.looseObject({ finished: z.literal(true), closed: z.boolean() }),
  z.looseObject({
    finished: z.literal(false),
    reason: z.string(),
    detail: z.string().optional(),
  }),
]);
function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// Done, with what landed saved first; then the finish op's labels and
// closure.
async function complete(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
): Promise<RoleEnd> {
  const entry = `done: merged code ${short(merged.code)}`;
  const done = logged(
    { ...state, stage: "done", landed: merged, landingReturn: null },
    entry,
  );
  await ctx.save(done);
  return await finish(ctx, done);
}

// The finish op on the saved completion `done`. Done only when it finished;
// new trusted inputs go to their requirements owner, and any other refusal (a security
// review that doesn't clear the landed result) stops, so no job retries a
// completion that can't finish.
async function finish(ctx: RoleContext, done: IssueState): Promise<RoleEnd> {
  const finished = await opReply(ctx, "finish", { state: done }, FINISHED);
  if (finished.finished) {
    return { kind: "next", state: done };
  }
  const detail = `the finish op refused (${finished.reason}): ${finished.detail ?? "no detail"}`;
  if (finished.reason === "inputs-changed") {
    return toRequirements(done, detail);
  }
  return failed(done, detail);
}

// Own Lands reuse the pre-Land clearance bound to their exact result, or an
// exact saved result observation; nothing launches a model pass after Land.
// Missing, stale or historical-only clearance stops with its evidence kept.
function completionSecurity(
  state: IssueState,
  result: Revision,
): Step<IssueState> {
  const refusal = securityRefusal(state, result);
  if (refusal === undefined) {
    return { ok: true, value: state };
  }
  return ended(failed(state, `${refusal}; ${NO_POST_LAND_REPAIR}`));
}

// Bound pre-Land Security clearance of the observed `result` of the receipt
// `merged`, then durable completion.
async function reviewedAndCompleted(
  ctx: RoleContext,
  state: IssueState,
  { merged, result }: { merged: Revision; result: Revision },
): Promise<RoleEnd> {
  const rejected = rejectedAgain(state, result);
  if (rejected !== null) {
    return rejected;
  }
  const security = completionSecurity(state, result);
  if (!security.ok) {
    return security.end;
  }
  return await complete(ctx, security.value, merged);
}

// A done issue with its completion saved, back at merge because the finish
// op didn't finish it: the finish op again, and nothing else, once the
// trusted inputs are still the landed ones, GitHub still confirms the
// merged code and a security receipt approves exactly what landed.
// A code completion also needs read-only confirmation of its pre-Land proof;
// a completion with no exact clearance (including a legacy wiki head) needs
// reconciliation: no review here covers it. A saved rejection stops again.
async function finishCompleted(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
): Promise<RoleEnd> {
  const current = await currentRevision(ctx);
  const { revision, pr } = current;
  const { gherkin } = ctx.inputs;
  if (
    !requirementsHold(state, gherkin, revision.inputs) ||
    merged.inputs !== revision.inputs
  ) {
    return toRequirements(state, "the trusted inputs changed since the merge");
  }
  const codeConfirmed =
    merged.code === null ||
    (pr !== null &&
      pr.number === state.pr &&
      pr.state === "MERGED" &&
      pr.mergeCommit === merged.code);
  if (!codeConfirmed) {
    return failed(
      state,
      `the completion records code ${merged.code} merged, and GitHub doesn't confirm PR #${state.pr} merged as it`,
    );
  }
  return await finishConfirmed(ctx, state, merged, current);
}

async function finishConfirmed(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
  current: CurrentRevision,
): Promise<RoleEnd> {
  const { revision } = current;
  let codeMerged: CodeLanded | null = null;
  if (merged.code !== null && state.pr !== null) {
    codeMerged = { pr: state.pr, sha: merged.code };
  }
  const rejected = rejectedAgain(state, merged);
  if (rejected !== null) {
    return rejected;
  }
  if (
    legacyWikiOf(merged) !== null &&
    (state.security === null || !sameRevision(state.security.revision, merged))
  ) {
    return failed(
      state,
      "a completion saved with a legacy wiki head has no exact security clearance; explicit reconciliation is required before completion",
    );
  }
  let observed = merged;
  if ((merged.policy ?? null) !== (revision.policy ?? null)) {
    const result = ownLandResultObservation(state, current);
    if (result === null) {
      return failed(
        state,
        "current policy cannot reauthorize an unproven historical merge",
      );
    }
    observed = result;
  }
  if (codeMerged !== null) {
    const refused = await confirmedLandedResult(ctx, state, {
      result: observed,
      codeMerged,
    });
    if (refused !== null) {
      return refused;
    }
  }
  const security = completionSecurity(state, observed);
  if (!security.ok) {
    return security.end;
  }
  return await finish(ctx, security.value);
}

export { finishCompleted, reviewedAndCompleted };
