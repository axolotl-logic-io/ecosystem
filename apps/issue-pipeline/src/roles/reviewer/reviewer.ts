// The Reviewer's hardening, the review stage's one role. A writing session
// owns the change's design, correctness and tests: it examines the
// Developer's draft against the trusted requirements, adds tests and fixes defects. The
// pipeline then verifies the result (`verify-runs-repo-checks`), with fix
// sessions within `maxCiFixes`, pushes it and checkpoints the exact revision
// it hardened (`state.hardened`), which alone authorizes the merge
// (`approval-is-for-one-revision`); only then is the draft PR marked ready.
// Hardening never rebases or syncs the change: the merge stage integrates
// it. The security review comes after the merge (src/roles/merge/).

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import {
  DEVELOPER_RECOVERY_REASON,
  requirementsHold,
  requirementsStage,
  requirementsState,
} from "../../requirements.ts";
import type { IssueState, Revision } from "../../state.ts";
import { approvalHolds, withLog } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { changeModeOf, SHORT_SHA } from "../change-task.ts";
import { opReply, PUSH_REPLY, readyPr } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { codeMergeConfirmed, currentRevision } from "../revision-source.ts";
import { verifiedHead } from "../verification.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop, writerSession } from "../writer-session.ts";
import { hardeningTask } from "./task.ts";

// The config's bound on a job's check-fix sessions; its defaults fill it in.
const CHECK_FIXES = z.looseObject({
  maxCiFixes: z.number().int().nonnegative(),
});

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The trusted requirements moved: their owner goes first, and the
// issue comes back to review.
function toRequirements(state: IssueState, why: string): RoleEnd {
  const next = requirementsState(state, "review");
  if (next === null) {
    return errorStop(state, `${why}; ${DEVELOPER_RECOVERY_REASON}`);
  }
  return {
    kind: "next",
    state: logged(next, `${why}; back to ${requirementsStage(state)}`),
  };
}

// Why `current` can't be hardened now, or null when it can.
function notHardenable(
  ctx: RoleContext,
  current: CurrentRevision,
): RoleEnd | null {
  const { state } = ctx;
  const { gherkin } = ctx.inputs;
  if (!requirementsHold(state, gherkin, current.revision.inputs)) {
    return toRequirements(state, "the trusted inputs need requirements review");
  }
  const { codeMerged } = state;
  if (codeMerged !== null && !codeMergeConfirmed(current, codeMerged)) {
    return errorStop(
      state,
      `GitHub doesn't confirm PR #${codeMerged.pr} merged as ${codeMerged.sha}, as the claim recorded`,
    );
  }
  if (current.revision.code === null) {
    return errorStop(state, "nothing to harden: no code head");
  }
  return null;
}

// The hardening session; null when it says it is done.
async function hardeningSession(
  ctx: RoleContext,
  state: IssueState,
  mode: Mode,
): Promise<Step<never> | null> {
  const session = await writerSession(ctx, state, {
    phase: "hardening",
    task: hardeningTask(ctx, mode),
    what: "hardening",
  });
  if (!session.ok) {
    return session;
  }
  const reply = session.value;
  if (reply.outcome === "done") {
    return null;
  }
  if (reply.outcome === "cannot") {
    const reason = `hardening found a question only a person can answer: ${reply.reason}`;
    return ended({ kind: "stop", code: "not-doable", reason, state });
  }
  return ended(
    errorStop(
      state,
      `the hardening session replied ${reply.outcome} to its hardening task`,
    ),
  );
}

// Pushes the verified branch head `verified`; a push of anything else
// stops. Once the code merged, `verified` is the merge commit and nothing is
// pushed.
async function pushHardened(
  ctx: RoleContext,
  state: IssueState,
  { mode, verified }: { mode: Mode; verified: string },
): Promise<Step<IssueState>> {
  if (mode.kind !== "branch") {
    return { ok: true, value: { ...state, verifiedSha: verified } };
  }
  const pushed = await opReply(ctx, "push", { number: ctx.issue }, PUSH_REPLY);
  if (pushed.headSha !== verified) {
    return ended(
      errorStop(
        state,
        `the push left the code head at ${pushed.headSha}, not the verified ${verified}`,
      ),
    );
  }
  if (!pushed.codeChanged) {
    return ended(
      errorStop(
        state,
        "after hardening the branch changes no code file, so its PR has nothing to merge",
      ),
    );
  }
  const flows = { code: true };
  return {
    ok: true,
    value: { ...state, headSha: pushed.headSha, verifiedSha: verified, flows },
  };
}

// The hardened state: `revision`, read after the push, is checkpointed as
// the one revision the merge may take.
function checkpoint(state: IssueState, revision: Revision): IssueState {
  return {
    ...state,
    stage: "review",
    hardened: revision,
    integration: null,
    mergeReturn: null,
  };
}

interface Hardened {
  state: IssueState;
  revision: Revision;
}

// Postmerge writers must read M, not the retained source head H. Checkout
// availability grants no authority.
async function hardeningSetup(
  ctx: RoleContext,
  mode: Mode,
): Promise<string | null> {
  if (mode.kind !== "merged") {
    return null;
  }
  const prepared = await opReply(
    ctx,
    "prepare-review",
    { number: ctx.issue, codeMerged: mode.merged, tag: "hardening" },
    z.looseObject({ headSha: z.string() }),
  );
  if (prepared.headSha !== mode.merged.sha) {
    return `prepare-review read ${prepared.headSha}, not the merge commit ${mode.merged.sha}`;
  }
  return null;
}

// Hardens the revision `before` and checkpoints the result, or says why not.
async function harden(
  ctx: RoleContext,
  start: IssueState,
  before: Revision,
): Promise<Step<Hardened>> {
  const mode = changeModeOf(start);
  const hold = await hardeningSetup(ctx, mode);
  if (hold !== null) {
    return ended(errorStop(start, hold));
  }
  const refused = await hardeningSession(ctx, start, mode);
  if (refused !== null) {
    return refused;
  }
  const { maxCiFixes } = CHECK_FIXES.parse(ctx.cfg);
  const verified = await verifiedHead(ctx, start, {
    mode,
    phase: "hardening",
    maxCiFixes,
  });
  if (!verified.ok) {
    return verified;
  }
  const pushed = await pushHardened(ctx, start, {
    mode,
    verified: verified.value,
  });
  if (!pushed.ok) {
    return pushed;
  }
  const state = pushed.value;
  const after = await currentRevision(ctx);
  if (after.revision.inputs !== before.inputs) {
    return ended(
      toRequirements(state, "the trusted inputs changed during hardening"),
    );
  }
  if (after.revision.code !== verified.value) {
    return ended({
      kind: "wait",
      reason: `the code head moved to ${short(after.revision.code)} after hardening verified ${short(verified.value)}; the next job hardens the new head`,
      state: logged(state, "hardening not checkpointed: the head moved"),
    });
  }
  const { revision } = after;
  const entry = `hardened code ${short(revision.code)}`;
  const hardened = logged(checkpoint(state, revision), entry);
  return { ok: true, value: { state: hardened, revision } };
}

// The hardening's own comment, on the PR or, with none, the issue. It says
// only that hardening passed: no security review has run yet.
async function postHardened(
  ctx: RoleContext,
  state: IssueState,
  revision: Revision,
): Promise<void> {
  let on: "issue" | "pr" = "pr";
  if (state.pr === null) {
    on = "issue";
  }
  await ctx.post({
    key: "hardening",
    on,
    role: "reviewer",
    body: `## Hardening passed\n\nThe Reviewer hardened code \`${short(revision.code)}\`, and the pipeline's checks passed on it. The merge stage integrates exactly this revision; the security review runs on the merged result.`,
  });
}

// The checkpointed state goes on to merge, its PR marked ready first.
async function toMerge(
  ctx: RoleContext,
  state: IssueState,
  why: string,
): Promise<RoleEnd> {
  await readyPr(ctx, state);
  const next: IssueState = { ...state, stage: "merge" };
  return { kind: "next", state: logged(next, `${why}; on to merge`) };
}

const reviewerRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const before = await currentRevision(ctx);
  const refused = notHardenable(ctx, before);
  if (refused !== null) {
    return refused;
  }
  // A hardening checkpointed for exactly this revision needs no session
  // again: an interrupted job left its PR to mark ready.
  if (approvalHolds(ctx.state, before.revision)) {
    return await toMerge(ctx, ctx.state, "hardening already passed");
  }
  const hardened = await harden(ctx, ctx.state, before.revision);
  if (!hardened.ok) {
    return hardened.end;
  }
  const { state, revision } = hardened.value;
  await ctx.save(state);
  await postHardened(ctx, state, revision);
  return await toMerge(ctx, state, "hardening passed");
};

export { reviewerRole };
