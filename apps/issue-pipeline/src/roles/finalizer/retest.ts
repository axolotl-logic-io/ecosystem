// The finalizer's retest of a clean rebase before the merge (#422): verify
// with testsOnly at the rebased head, then ci-status at it. A pass records
// verifiedSha and goes on to the merge, as the checks stage does for a clean
// rebase of a passed head; acceptance and security passed before the
// rebase, so neither runs again. A failed retest saves at `checks` with
// testsOnly cleared, so the CI fixer runs. Pending CI ends held at `merge`;
// the next job finds the head at verifiedSha and only waits on CI. Pure.

import { clip } from "../../workflow/clip.ts";
import type { Check } from "../../workflow/stages/checks-reply.ts";
import {
  ciReplyOf,
  isRecord,
  verifyReplyOf,
} from "../../workflow/stages/checks-reply.ts";
import {
  CI_MARGIN_MINUTES,
  VERIFY_MINUTES,
} from "../../workflow/stages/checks-round.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { Effect } from "../machine.ts";
import type { LinearStep } from "../walk.ts";
import { ended, noted, opFailed, stoppedFor } from "./ends.ts";
import type { FinalizerData } from "./locate.ts";

const SUMMARY_LIMIT = 1500;
const LOG_SHA = 8;

function recordOf(raw: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(raw)) {
    return raw;
  }
  return {};
}

function shortHead(data: FinalizerData): string {
  return (data.headSha ?? "").slice(0, LOG_SHA);
}

// `data` saved at `checks` with testsOnly cleared, noting `note`.
function toChecks(data: FinalizerData, note: string): FinalizerData {
  const back = { ...noted(data, note), testsOnly: false };
  return ended(back, { kind: "saved", stage: "checks" });
}

// The tests at the rebased head, with the rebase's comment.
function verifyEffect(data: FinalizerData): Effect {
  const { issue: number, stackedOn, comments } = data;
  const payload = { number, testsOnly: true, ...stackFields(stackedOn) };
  return {
    kind: "op",
    op: "verify",
    payload: { ...payload, comments },
    minutes: VERIFY_MINUTES,
  };
}

function summaryOf(checks: readonly Check[]): string {
  const lines = checks.map((check) => `${check.id}: ${check.detail}`);
  return clip(lines.join("; "), SUMMARY_LIMIT);
}

function verified(data: FinalizerData, raw: unknown): FinalizerData {
  const reply = verifyReplyOf(recordOf(raw));
  const sent = { ...data, comments: [] };
  if (reply.kind === "failed") {
    const why = reply.error ?? "the verify reply is unreadable";
    return opFailed(sent, "verify", "local verification could not run", why);
  }
  const { headSha, checks } = reply;
  if (headSha !== data.headSha) {
    return stoppedFor(sent, "the branch changed during verification", null);
  }
  if (!reply.pass) {
    const failing = checks.filter((check) => !check.pass).map((c) => c.id);
    const note = `retest failed at ${shortHead(data)} (${failing.join(", ")}); the CI fixer runs at checks`;
    return toChecks(sent, note);
  }
  const verifySummary = summaryOf(checks);
  return { ...sent, verifiedSha: headSha, verifySummary, retest: "ci" };
}

const verifyStep: LinearStep<FinalizerData> = {
  name: "retest-verify",
  kind: "script",
  skip: (data: FinalizerData): boolean =>
    data.end !== null || data.retest !== "verify",
  effect: verifyEffect,
  apply: verified,
  recover: (data: FinalizerData, error: string): FinalizerData =>
    opFailed(data, "verify", "local verification could not run", error),
};

function ciEffect(data: FinalizerData): Effect {
  const { issue: number, st, headSha, settings } = data;
  const payload = { number, pr: st.pr, expectedSha: headSha };
  const minutes = settings.cfg.ciWaitMinutes + CI_MARGIN_MINUTES;
  return { kind: "op", op: "ci-status", payload, minutes };
}

// CI is still running: held at merge, noted once while the wait lasts.
function pending(data: FinalizerData): FinalizerData {
  const note = "CI still running after the rebase; will check next job";
  const last = data.log.at(-1) ?? "";
  if (last.includes(note)) {
    return ended(data, { kind: "held" });
  }
  return ended(noted(data, note), { kind: "held" });
}

function ciRead(data: FinalizerData, raw: unknown): FinalizerData {
  const reply = ciReplyOf(recordOf(raw));
  const head = shortHead(data);
  switch (reply.kind) {
    case "failed": {
      const why = reply.error ?? "the ci-status reply is unreadable";
      return opFailed(data, "ci-status", "could not read CI status", why);
    }
    case "pass": {
      const note = `checks passed at ${head}; acceptance and security passed before the rebase`;
      return { ...noted(data, note), testsOnly: false, retest: "merge" };
    }
    case "pending":
      return pending(data);
    case "fail": {
      const failing = reply.failing.join(", ");
      const note = `CI failed at ${head} (${failing}); the CI fixer runs at checks`;
      return toChecks(data, note);
    }
    case "no-checks": {
      const reason =
        "the PR has no required CI checks, and this repo's config requires them";
      return stoppedFor(data, reason, null);
    }
    case "moved": {
      const reason = "the branch changed outside the pipeline while CI ran";
      return stoppedFor(data, reason, reply.headSha);
    }
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

const ciStep: LinearStep<FinalizerData> = {
  name: "retest-ci",
  kind: "script",
  skip: (data: FinalizerData): boolean =>
    data.end !== null || data.retest !== "ci",
  effect: ciEffect,
  apply: ciRead,
  recover: (data: FinalizerData, error: string): FinalizerData =>
    opFailed(data, "ci-status", "could not read CI status", error),
};

export { ciStep, verifyStep };
