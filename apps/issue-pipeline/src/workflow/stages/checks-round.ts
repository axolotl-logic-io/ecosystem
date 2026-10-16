// How a checks round starts and what it checks, by the issue's flows
// (flows.ts): an issue that changes the wiki has its wiki pages checked
// first (wiki-check), then one that changes code is verified with the repo's
// own commands and waits for CI. A change that lives only in the wiki skips
// verification and CI. A failed check of either kind goes to a CI fix
// (ci-fix.ts), described the same way.

import type { Check } from "./checks-reply.ts";
import { checksOf } from "./checks-reply.ts";
import { startFix } from "./ci-fixer.ts";
import { opFailedStep } from "./network.ts";
import { textOrNull } from "./replies.ts";
import { branchPayload } from "./stacked.ts";
import { launchStep, onlyReply } from "./step.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// How checks goes on once a round's checks have all passed.
type Passed = (state: StageState, ctx: StageContext) => Step;

const VERIFY_MINUTES = 120;
// What acceptance is told passed for a change that lives only in the wiki.
const WIKI_ONLY_SUMMARY = "wiki-check: passed; no code changed";
// Minutes the CI wait gets beyond the configured wait.
const CI_MARGIN_MINUTES = 10;

// A failed check, as a fixer reads it.
function failureLine(check: Check): string {
  let line = `- ${check.id}: ${check.detail}`;
  if (check.log !== "") {
    line += ` (log: ${check.log})`;
  }
  if (check.tail !== "") {
    line += `\n${check.tail}`;
  }
  return line;
}

function ciLaunch(
  state: StageState,
  ctx: StageContext,
  comments: readonly StageComment[],
): Step {
  const { st } = state;
  const payload = { number: state.n, pr: st.pr, expectedSha: st.headSha };
  const minutes = ctx.cfg.ciWaitMinutes + CI_MARGIN_MINUTES;
  return launchStep(
    { ...state, phase: "ci" },
    [{ kind: "op", name: "ci", op: "ci-status", payload, minutes }],
    comments,
  );
}

// Verifies the head. A head that already passed local verification (such as
// one waiting on CI last sweep) skips straight to CI.
function verifyRound(state: StageState, ctx: StageContext): Step {
  const { verifiedSha, headSha, testsOnly } = state.st;
  if (
    typeof verifiedSha === "string" &&
    verifiedSha !== "" &&
    verifiedSha === headSha
  ) {
    return ciLaunch(state, ctx, []);
  }
  const payload = branchPayload(state, { testsOnly: testsOnly === true });
  return launchStep({ ...state, phase: "verified" }, [
    {
      kind: "op",
      name: "verify",
      op: "verify",
      payload,
      minutes: VERIFY_MINUTES,
    },
  ]);
}

// Starts round `rounds`: the wiki check first when the issue changes the
// wiki, else verification.
function startRound(
  state: StageState,
  ctx: StageContext,
  rounds: number,
): Step {
  const counted = { ...state, carry: { rounds } };
  if (state.st.flows?.wiki !== true) {
    return verifyRound(counted, ctx);
  }
  const payload = { number: state.n };
  return launchStep({ ...counted, phase: "wiki-checked" }, [
    { kind: "op", name: "wiki-check", op: "wiki-check", payload },
  ]);
}

// Passing wiki pages go on to verification, or through `passed` when the
// change lives only in the wiki, which records the checked head as verified;
// failing ones go to a CI fix.
function wikiChecked(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  passed: Passed,
): Step {
  const { ok, error, pass, checks } = onlyReply(results);
  if (ok !== true) {
    const reason = "the wiki check could not run";
    const failed = { op: "wiki-check", reason, error: textOrNull(error) };
    return opFailedStep(state, failed, ctx.now());
  }
  if (pass !== true) {
    const bad = (checksOf(checks) ?? []).filter((check) => !check.pass);
    return startFix(state, ctx, bad.map(failureLine).join("\n"), []);
  }
  if (state.st.flows?.code === false) {
    // The checked head is what acceptance reviews and merge publishes.
    const st = {
      ...state.st,
      verifiedSha: state.st.headSha ?? null,
      verifySummary: WIKI_ONLY_SUMMARY,
    };
    return passed({ ...state, st }, ctx);
  }
  return verifyRound(state, ctx);
}

export { ciLaunch, failureLine, startRound, wikiChecked };
