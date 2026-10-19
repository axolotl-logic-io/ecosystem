// The Reviewer's own integration of the hardened revision at merge: the
// final synchronization with the base and the wiki (src/roles/merge/sync.ts)
// once the merge queue reaches the issue, and the fixes of checks that fail
// at merge, each in bounded Reviewer writer sessions. The pipeline then
// checks the exact result (verify and wiki-check, src/roles/verification.ts),
// pushes it and saves the integration receipt: `state.integration` binds the
// hardened revision to the integrated one, which the merge may then take
// once CI passes on it, with no model review of the integration's own work.
// The hardened revision stays as it was. Every integration counts one of
// the issue's `maxSyncs`; a head that moved by anything but this module is
// never integrated, it goes back to hardening.

import { z } from "zod";
import { flowsOf } from "../../flows.ts";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import { mergeAuthorization, sameRevision } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { changeModeOf, SHORT_SHA } from "../change-task.ts";
import type { Check, Conflict } from "../op-replies.ts";
import { opReply, PUSH_REPLY } from "../op-replies.ts";
import { currentRevision } from "../revision-source.ts";
import { verifiedHead } from "../verification.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { counted, logged, toAuthor, toReview, waiting } from "./returns.ts";
import { syncSide } from "./sync.ts";

// The config's bounds on an integration's sessions; its defaults fill them
// in.
const LIMITS = z.looseObject({
  maxCiFixes: z.number().int().nonnegative(),
  maxConflictFixes: z.number().int().nonnegative(),
});

// What an integration does: rebase the code branch onto its base (only at
// the head of the merge queue) and the wiki branch onto the wiki's latest
// version, go on with a wiki rebase that already stopped on conflicts, and
// fix checks that already failed.
interface IntegrationNeed {
  rebase: { code: boolean; wiki: boolean };
  wikiConflict: Conflict | null;
  failing: readonly Check[];
  // Why the integration runs, for the log.
  why: string;
}

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The code and wiki synchronization an integration needs.
async function synced(
  ctx: RoleContext,
  start: IssueState,
  { mode, need }: { mode: Mode; need: IntegrationNeed },
): Promise<Step<IssueState>> {
  const { maxConflictFixes } = LIMITS.parse(ctx.cfg);
  let state = start;
  if (mode.kind === "branch" && need.rebase.code) {
    const code = await syncSide(ctx, state, { side: "code", maxConflictFixes });
    if (!code.ok) {
      return code;
    }
    state = code.value;
  }
  if (ctx.dirs.docs === null) {
    return { ok: true, value: state };
  }
  if (need.wikiConflict !== null) {
    return await syncSide(ctx, state, {
      side: "wiki",
      maxConflictFixes,
      first: need.wikiConflict,
    });
  }
  if (!need.rebase.wiki) {
    return { ok: true, value: state };
  }
  return await syncSide(ctx, state, { side: "wiki", maxConflictFixes });
}

// Pushes the integrated, verified branch or the wiki alone. Once code has
// merged, `verified` is M, not the retained issue head H reported by a
// wiki-only push; currentRevision still checks the receipt against M.
async function pushIntegrated(
  ctx: RoleContext,
  state: IssueState,
  { mode, verified }: { mode: Mode; verified: string },
): Promise<Step<IssueState>> {
  let payload: object = { number: ctx.issue };
  if (mode.kind !== "branch") {
    payload = { number: ctx.issue, wikiOnly: true };
  }
  const pushed = await opReply(ctx, "push", payload, PUSH_REPLY);
  if (mode.kind !== "wiki-only" && pushed.headSha !== verified) {
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
      flows: flowsOf(pushed),
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
  const entry = `integrated code ${short(hardened.code)} as ${short(revision.code)}, wiki ${short(hardened.wiki)} as ${short(revision.wiki)}; verified and wiki-checked`;
  return {
    kind: "wait",
    reason:
      "the integrated revision is checked locally; the merge waits for its required CI",
    state: logged(integrated, entry),
  };
}

// Integrates the hardened revision of `start` as `need` says. Ends waiting
// with the receipt saved, so the next merge job merges the integrated
// revision once its CI passes, or with the stop or return that came first.
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
