// Integration may fix/synchronize a candidate, but changed code needs fresh
// hardening and Security. Its receipt records history, not merge permission.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import { mergeAuthorization, sameRevision } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { changeModeOf, SHORT_SHA } from "../change-task.ts";
import type { Check } from "../op-replies.ts";
import { opReply, PUSH_REPLY } from "../op-replies.ts";
import { currentRevision } from "../revision-source.ts";
import { verifiedHead } from "../verification.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { counted, logged, toAuthor, toReview, waiting } from "./returns.ts";
import { syncCode } from "./sync.ts";

// The config's bounds on an integration's sessions; its defaults fill them
// in.
const LIMITS = z.looseObject({
  maxCiFixes: z.number().int().nonnegative(),
  maxConflictFixes: z.number().int().nonnegative(),
});

// What an integration does: rebase the code branch onto its base (only at
// the head of the merge queue), and fix checks that already failed.
interface IntegrationNeed {
  rebase: boolean;
  failing: readonly Check[];
  // Why the integration runs, for the log.
  why: string;
}

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The code synchronization an integration needs.
async function synced(
  ctx: RoleContext,
  state: IssueState,
  { mode, need }: { mode: Mode; need: IntegrationNeed },
): Promise<Step<IssueState>> {
  if (mode.kind !== "branch" || !need.rebase) {
    return { ok: true, value: state };
  }
  const { maxConflictFixes } = LIMITS.parse(ctx.cfg);
  return await syncCode(ctx, state, maxConflictFixes);
}

// Pushes the integrated, verified branch. Once code has merged, `verified`
// is M and nothing is pushed; currentRevision still checks the receipt
// against M.
async function pushIntegrated(
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
        `the integration's push left the code head at ${pushed.headSha}, not the verified ${verified}`,
      ),
    );
  }
  return {
    ok: true,
    value: {
      ...state,
      headSha: pushed.headSha,
      verifiedSha: verified,
      flows: { code: pushed.codeChanged },
    },
  };
}

// The receipt of the integration of `hardened`, from the authorized
// revision `from`, as `revision`, read fresh after the push; or where the
// issue goes when that revision isn't the one the integration checked.
function receipt(
  state: IssueState,
  {
    hardened,
    from,
    revision,
    verified,
  }: {
    hardened: Revision;
    from: Revision;
    revision: Revision;
    verified: string;
  },
): RoleEnd {
  if (revision.inputs !== hardened.inputs) {
    return toAuthor(state, "the trusted inputs changed during the integration");
  }
  if (revision.code !== verified) {
    return toReview(
      state,
      `the code head moved to ${short(revision.code)} after the integration verified ${short(verified)}`,
    );
  }
  if (sameRevision(revision, from)) {
    return waiting(
      logged(state, "the integration changed nothing; its checks now pass"),
      "the checks pass on the authorized revision; the next merge job merges it",
    );
  }
  const integrated: IssueState = {
    ...state,
    integration: { reviewed: hardened, revision },
  };
  const entry = `integrated code ${short(hardened.code)} as ${short(revision.code)}; verified`;
  return toReview(
    logged(integrated, entry),
    "integration changed the candidate; fresh hardening and Security are required",
  );
}

// Integrate the hardened revision as needed. Changed code returns to Review;
// unchanged checked code waits for the next merge job.
async function integrate(
  ctx: RoleContext,
  start: IssueState,
  need: IntegrationNeed,
): Promise<RoleEnd> {
  const { hardened } = start;
  const from = mergeAuthorization(start);
  if (hardened === null || from === null) {
    return toReview(start, "nothing hardened to integrate");
  }
  const bound = counted(ctx, start);
  if ("stop" in bound) {
    return bound.stop;
  }
  const mode = changeModeOf(start);
  let state = logged(bound.state, `integrating: ${need.why}`);
  await ctx.save(state);
  const sync = await synced(ctx, state, { mode, need });
  if (!sync.ok) {
    return sync.end;
  }
  state = sync.value;
  const { maxCiFixes } = LIMITS.parse(ctx.cfg);
  const verified = await verifiedHead(ctx, state, {
    mode,
    phase: "integration",
    maxCiFixes,
    failing: need.failing,
  });
  if (!verified.ok) {
    return verified.end;
  }
  const pushed = await pushIntegrated(ctx, state, {
    mode,
    verified: verified.value,
  });
  if (!pushed.ok) {
    return pushed.end;
  }
  const { revision } = await currentRevision(ctx);
  return receipt(pushed.value, {
    hardened,
    from,
    revision,
    verified: verified.value,
  });
}

export type { IntegrationNeed };
export { integrate };
