// Checks: checks the wiki pages of an issue that changes the wiki, verifies
// the head of one that changes code with the repo's own commands, then waits
// for CI (checks-round.ts). Passing checks move to acceptance, or straight to
// merge after a clean rebase of a head that passed everything before; failing
// ones get CI-fix rounds (ci-fix.ts) until they pass or the limit is reached.

import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { byStep } from "../signing.ts";
import type { IssueState } from "../types.ts";
import type { Check } from "./checks-reply.ts";
import {
  ciReplyOf,
  isRecord,
  pushedOf,
  verifyReplyOf,
} from "./checks-reply.ts";
import {
  ciLaunch,
  failureLine,
  startRound,
  wikiChecked,
} from "./checks-round.ts";
import { fixed, prepared, prepareFix, reviewed } from "./ci-fix.ts";
import { startFix } from "./ci-fixer.ts";
import { flowStep, prFlowed } from "./flow-step.ts";
import { opFailedStep } from "./network.ts";
import {
  doneStep,
  onlyReply,
  phaseOf,
  pushFailedStep,
  stopStep,
} from "./step.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where checks is: about to start, reading the wiki check, verification or
// CI, in a CI fix (ci-fix.ts, whose push may be retried once and may close
// or reopen the PR, flow-step.ts), or after a CI fix's state was saved.
type ChecksPhase =
  | "begin"
  | "wiki-checked"
  | "verified"
  | "ci"
  | "fixed"
  | "pushed"
  | "repushed"
  | "flowed"
  | "prepared"
  | "reviewed"
  | "saved";

const PHASES: readonly ChecksPhase[] = [
  "begin",
  "wiki-checked",
  "verified",
  "ci",
  "fixed",
  "pushed",
  "repushed",
  "flowed",
  "prepared",
  "reviewed",
  "saved",
];

const SUMMARY_LIMIT = 1500;
const SHORT_SHA = 12;
const LOG_SHA = 8;

// How many rounds checks has started this sweep (what it carries).
function roundsOf(state: StageState): number {
  const { carry } = state;
  if (isRecord(carry)) {
    const { rounds } = carry;
    if (typeof rounds === "number") {
      return rounds;
    }
  }
  throw new Error("checks: expected the round count");
}

function headOf(st: IssueState): string {
  return st.headSha ?? "";
}

function prComment(role: string, body: string): StageComment {
  return { by: byStep(role), body, where: "pr" };
}

function checkLine(check: Check): string {
  let mark = "❌";
  if (check.pass) {
    mark = "✅";
  }
  return `- ${mark} ${check.id}: ${check.detail}`;
}

// Posts the checks' table, then goes on to CI, or to a fix when one failed.
function verified(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = verifyReplyOf(onlyReply(results));
  if (reply.kind === "failed") {
    const reason = "local verification could not run";
    const failed = { op: "verify", reason, error: reply.error };
    return opFailedStep(state, failed, ctx.now());
  }
  const { headSha, checks } = reply;
  if (headSha !== state.st.headSha) {
    return stopStep(state, "the branch changed during verification", null);
  }
  const table = checks.map(checkLine).join("\n");
  const comment = prComment(
    "local checks",
    `Ran the repo's commands on ${headSha.slice(0, SHORT_SHA)}.\n\n${table}`,
  );
  if (!reply.pass) {
    const bad = checks.filter((check) => !check.pass);
    return startFix(state, ctx, bad.map(failureLine).join("\n"), [comment]);
  }
  const st: IssueState = { ...state.st };
  st.verifiedSha = headSha;
  st.verifySummary = clip(
    checks.map((check) => `${check.id}: ${check.detail}`).join("; "),
    SUMMARY_LIMIT,
  );
  return ciLaunch({ ...state, st }, ctx, [comment]);
}

// A CI fix was pushed: records the head and acts on its flows (flow-step.ts),
// then prepares its diff (ci-fix.ts). A failed push is retried once unless
// git's push was rejected.
function fixPushed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const raw = onlyReply(results);
  const reply = pushedOf(raw);
  if (reply.kind === "failed") {
    return pushFailedStep(state, "could not push the check fix", reply.error);
  }
  const st = { ...state.st, headSha: reply.value };
  const flowed = { phase: "flowed", goOn: prepareFix };
  return flowStep({ ...state, st }, ctx, raw, flowed);
}

// Checks passed: on to acceptance, or to merge when only the tests ran again.
function passed(state: StageState, ctx: StageContext): Step {
  const st: IssueState = { ...state.st };
  const rebasedOnly = st.testsOnly === true;
  let note = "";
  st.stage = "accept";
  if (rebasedOnly) {
    st.stage = "merge";
    note = "; acceptance and security passed before the rebase";
  }
  st.testsOnly = false;
  const head = headOf(st).slice(0, LOG_SHA);
  noteEvent(st, `checks passed at ${head}${note}`, ctx.now());
  return doneStep({ ...state, st, rebasedOnly });
}

// Acts on CI's status. Pending CI ends the stage until next sweep.
function ci(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = ciReplyOf(onlyReply(results));
  switch (reply.kind) {
    case "failed": {
      const reason = "could not read CI status";
      const failed = { op: "ci-status", reason, error: reply.error };
      return opFailedStep(state, failed, ctx.now());
    }
    case "pass":
      return passed(state, ctx);
    case "pending": {
      const st: IssueState = { ...state.st };
      noteEvent(st, "CI still running; will check next sweep", ctx.now());
      return doneStep({ ...state, st });
    }
    case "fail": {
      const failing = reply.failing.join(", ");
      const comment = prComment(
        "CI",
        `Required checks failed on ${headOf(state.st).slice(0, SHORT_SHA)}: ${failing}.`,
      );
      const failure = `CI checks failed: ${failing}\nFailed-job logs: ${reply.logPath}`;
      return startFix(state, ctx, failure, [comment]);
    }
    case "no-checks":
      return stopStep(
        state,
        "the PR has no required CI checks, and this repo's config requires them",
        null,
      );
    case "moved":
      return stopStep(
        state,
        "the branch changed outside the pipeline while CI ran",
        reply.headSha,
      );
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

// A CI fix was saved: the next round, unless the rounds are used up or the
// spawn cap holds the issue here until next sweep.
function saved(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  onlyReply(results);
  const rounds = roundsOf(state);
  if (rounds >= ctx.cfg.maxCiFixes + 1) {
    return stopStep(state, "checks did not pass within the CI-fix limit", null);
  }
  if (ctx.hasRoom("checks")) {
    return startRound(state, ctx, rounds + 1);
  }
  if (state.held) {
    return doneStep(state);
  }
  const st: IssueState = { ...state.st };
  noteEvent(
    st,
    "held at checks by the per-run spawn cap; continues next sweep",
    ctx.now(),
  );
  return doneStep({ ...state, st, held: true });
}

// Checks' next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf("checks", PHASES, state);
  switch (phase) {
    case "begin":
      return startRound(state, ctx, 1);
    case "wiki-checked":
      return wikiChecked(state, ctx, results, passed);
    case "verified":
      return verified(state, ctx, results);
    case "ci":
      return ci(state, ctx, results);
    case "fixed":
      return fixed(state, ctx, results);
    case "pushed":
    case "repushed":
      return fixPushed(state, ctx, results);
    case "flowed":
      return prFlowed(state, ctx, results, prepareFix);
    case "prepared":
      return prepared(state, ctx, results);
    case "reviewed":
      return reviewed(state, results);
    case "saved":
      return saved(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
