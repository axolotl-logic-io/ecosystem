// The pipeline's verification of a change (`verify-runs-repo-checks`): the
// repo's configured checks through `verify`, then `wiki-check`, never a
// session's word. The Reviewer runs it while it hardens a change and while
// it integrates one at merge. A failure gets a fix session of that phase, up
// to `maxCiFixes` of them in a job, and stops with check-fixes after that,
// or as soon as a fix session says no change in the repo can fix them. Once
// the code merged, verify checks the merge commit itself, which wiki-only
// work can't change, so a failure there stops with check-fixes without a fix
// session.

import type { RoleContext, RoleEnd } from "../job/role-context.ts";
import type { CodeMerged, IssueState } from "../state.ts";
import type { Mode } from "./change-task.ts";
import { fixTask } from "./change-task.ts";
import type { Check } from "./op-replies.ts";
import { opReply, VERIFY_REPLY, WIKI_CHECK_REPLY } from "./op-replies.ts";
import type { Step, WriterPhase } from "./writer-session.ts";
import { ended, errorStop, writerSession } from "./writer-session.ts";

interface Verification {
  headSha: string;
  codePass: boolean;
  wikiPass: boolean;
  failed: Check[];
}

// One job's verification loop: the state its stops keep, the mode, the
// phase its fix sessions run in and the most fix sessions it may run.
interface Loop {
  state: IssueState;
  mode: Mode;
  phase: WriterPhase;
  maxCiFixes: number;
}

type VerifyPayload =
  | { number: number }
  | { number: number; codeMerged: CodeMerged };

function verifyPayload(ctx: RoleContext, mode: Mode): VerifyPayload {
  if (mode.kind === "wiki-only") {
    return { number: ctx.issue, codeMerged: mode.merged };
  }
  return { number: ctx.issue };
}

async function verifyOnce(ctx: RoleContext, mode: Mode): Promise<Verification> {
  const verified = await opReply(
    ctx,
    "verify",
    verifyPayload(ctx, mode),
    VERIFY_REPLY,
  );
  const wiki = await opReply(
    ctx,
    "wiki-check",
    { number: ctx.issue },
    WIKI_CHECK_REPLY,
  );
  const failed = [...verified.checks, ...wiki.checks].filter(
    (check) => !check.pass,
  );
  return {
    headSha: verified.headSha,
    codePass: verified.pass,
    wikiPass: wiki.pass,
    failed,
  };
}

function failedIds({ failed }: { failed: readonly Check[] }): string {
  const ids = failed.map((check) => check.id);
  if (ids.length === 0) {
    return "no check named";
  }
  return ids.join(", ");
}

function checksStop(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "check-fixes", reason, state };
}

// How a verification ends the loop: the verified head, a stop, or null when
// a fix session may try.
function judged(
  loop: Loop,
  verification: Verification,
  attempt: number,
): Step<string> | null {
  const { state, mode, maxCiFixes } = loop;
  if (mode.kind === "wiki-only" && verification.headSha !== mode.merged.sha) {
    const reason = `verify checked ${verification.headSha}, not the merge commit ${mode.merged.sha}`;
    return ended(errorStop(state, reason));
  }
  if (verification.codePass && verification.wikiPass) {
    return { ok: true, value: verification.headSha };
  }
  if (mode.kind === "wiki-only" && !verification.codePass) {
    const reason = `checks still fail on the merged code at ${mode.merged.sha}, which wiki-only work can't change: ${failedIds(verification)}`;
    return ended(checksStop(state, reason));
  }
  if (attempt > maxCiFixes) {
    const reason = `checks still fail after ${maxCiFixes} check-fix attempts (maxCiFixes): ${failedIds(verification)}`;
    return ended(checksStop(state, reason));
  }
  return null;
}

// Fix attempt `attempt`'s session: null when it says it fixed the checks. A
// fixer that says it can't fix them ends the check fixes early, under the
// same control as running out of attempts.
async function fixSession(
  ctx: RoleContext,
  loop: Loop,
  { failed, attempt }: { failed: readonly Check[]; attempt: number },
): Promise<Step<never> | null> {
  const { state, mode, phase, maxCiFixes: max } = loop;
  const task = fixTask(ctx, mode, { failed, attempt, max });
  const session = await writerSession(ctx, state, {
    phase,
    task,
    what: "check fix",
  });
  if (!session.ok) {
    return session;
  }
  const reply = session.value;
  if (reply.outcome === "done") {
    return null;
  }
  if (reply.outcome === "cannot") {
    const reason = `fix attempt ${attempt} of ${max} found no change in the repo that fixes the failing checks (${failedIds({ failed })}): ${reply.reason}`;
    return ended(checksStop(state, reason));
  }
  const reason = `the check fix session replied ${reply.outcome}, not done or cannot`;
  return ended(errorStop(state, reason));
}

async function verifiedFrom(
  ctx: RoleContext,
  loop: Loop,
  attempt: number,
): Promise<Step<string>> {
  const verification = await verifyOnce(ctx, loop.mode);
  const end = judged(loop, verification, attempt);
  if (end !== null) {
    return end;
  }
  const { failed } = verification;
  const fixed = await fixSession(ctx, loop, { failed, attempt });
  if (fixed !== null) {
    return fixed;
  }
  return await verifiedFrom(ctx, loop, attempt + 1);
}

// The verified code head: verify and wiki-check pass on it, after up to
// `maxCiFixes` fix sessions of `phase`. Given `failing`, checks that already
// failed elsewhere (CI), the first fix session fixes them before any verify.
async function verifiedHead(
  ctx: RoleContext,
  state: IssueState,
  {
    mode,
    phase,
    maxCiFixes,
    failing = [],
  }: {
    mode: Mode;
    phase: WriterPhase;
    maxCiFixes: number;
    failing?: readonly Check[];
  },
): Promise<Step<string>> {
  const loop: Loop = { state, mode, phase, maxCiFixes };
  if (failing.length === 0) {
    return await verifiedFrom(ctx, loop, 1);
  }
  if (maxCiFixes === 0) {
    const reason = `checks failed and maxCiFixes allows no check-fix attempt: ${failedIds({ failed: failing })}`;
    return ended(checksStop(state, reason));
  }
  const fixed = await fixSession(ctx, loop, { failed: failing, attempt: 1 });
  if (fixed !== null) {
    return fixed;
  }
  return await verifiedFrom(ctx, loop, 2);
}

export { verifiedHead };
