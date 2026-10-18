// The job's checks for the implementor's `checks` entry (the wiki's
// Pipeline-Roles-Implementor, "Entry `checks`"): whether the head is
// verified already, and the wiki check, local verification and the CI
// wait, which run their ops, post their results on the PR and answer with
// the machine's result names; with ci-fix-checks.ts's reads of the session
// replies. An op that fails fails its check, which the runner ends: held on
// a transient error, stopped otherwise.

import { z } from "zod";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { STACKED_ON } from "../../stack.ts";
import { clip } from "../../workflow/clip.ts";
import type { Signature } from "../../workflow/signing.ts";
import { byStep } from "../../workflow/signing.ts";
import type { Check } from "../../workflow/stages/checks-reply.ts";
import {
  checksOf,
  ciReplyOf,
  isRecord,
  verifyReplyOf,
} from "../../workflow/stages/checks-reply.ts";
import { failureLine } from "../../workflow/stages/checks-round.ts";
import { stackFields } from "../../workflow/stages/stacked.ts";
import type { Checks, JobEffects } from "../registry.ts";
import type { Ops } from "./check-effects.ts";
import { opOf, posted, SHORT_SHA } from "./check-effects.ts";
import { fixReview, fixStatus } from "./ci-fix-checks.ts";
import { answer, guarded } from "./outcome.ts";

type Payload = CheckEffect["payload"];

// What the checks are given, and what the wiki check's op answers.
const FLOWS = z.object({ code: z.boolean(), wiki: z.boolean() }).nullable();
const WORK = z.looseObject({
  headSha: z.string().nullable(),
  verifiedSha: z.string().nullable(),
  flows: FLOWS,
});
const WIKI = z.looseObject({ flows: FLOWS });
const WIKI_REPLY = z.looseObject({ pass: z.boolean(), checks: z.unknown() });
const VERIFY = z.looseObject({
  headSha: z.string(),
  testsOnly: z.boolean(),
  pr: z.number().nullable(),
  stackedOn: STACKED_ON.optional(),
});
const CI = z.looseObject({
  pr: z.number().nullable(),
  expectedSha: z.string(),
  minutes: z.number(),
});

// Today's checks stage's verify timeout (stages/checks-round.ts).
const VERIFY_MINUTES = 120;
const SUMMARY_LIMIT = 1500;

function stepBy(ops: Ops, role: string): Signature {
  return { ...byStep(role), run: ops.jobId };
}

function failedLines(checks: readonly Check[]): string {
  return checks
    .filter((check) => !check.pass)
    .map(failureLine)
    .join("\n");
}

function checkLine(check: Check): string {
  let mark = "❌";
  if (check.pass) {
    mark = "✅";
  }
  return `- ${mark} ${check.id}: ${check.detail}`;
}

// `verified` for a head that passed and still changes code, else `work`.
function checksWork(payload: Payload): Outcome {
  const { headSha, verifiedSha, flows } = WORK.parse(payload);
  const verified = typeof headSha === "string" && headSha !== "";
  if (verified && headSha === verifiedSha && flows?.code !== false) {
    return answer("verified");
  }
  return answer("work");
}

// Checks the wiki pages when the issue changes them: `wiki-only` when the
// wiki is the whole change.
async function wikiCheck(ops: Ops, payload: Payload): Promise<Outcome> {
  const { flows } = WIKI.parse(payload);
  if (flows?.wiki !== true) {
    return answer("pass");
  }
  const done = await opOf(ops, "wiki-check", {});
  if (!done.ok) {
    return done;
  }
  const { pass, checks } = WIKI_REPLY.parse(done.reply);
  if (!pass) {
    return answer("fail", { failure: failedLines(checksOf(checks) ?? []) });
  }
  if (flows.code) {
    return answer("pass");
  }
  return answer("wiki-only");
}

// Runs the repo's commands on the head and posts their table.
async function verify(ops: Ops, payload: Payload): Promise<Outcome> {
  const { headSha, testsOnly, pr, stackedOn } = VERIFY.parse(payload);
  const request = { testsOnly, ...stackFields(stackedOn) };
  const done = await opOf(ops, "verify", request, VERIFY_MINUTES);
  if (!done.ok) {
    return done;
  }
  const reply = verifyReplyOf(recordOf(done.reply));
  if (reply.kind === "failed") {
    return {
      ok: false,
      error: reply.error ?? "verify's reply could not be read",
    };
  }
  if (reply.headSha !== headSha) {
    return answer("moved");
  }
  const { checks } = reply;
  const table = checks.map(checkLine).join("\n");
  const body = `Ran the repo's commands on ${headSha.slice(0, SHORT_SHA)}.\n\n${table}`;
  const comment = await posted(ops, pr, [
    { by: stepBy(ops, "local checks"), body },
  ]);
  if (!comment.ok) {
    return comment;
  }
  if (!reply.pass) {
    return answer("fail", { failure: failedLines(checks) });
  }
  const summary = checks.map((check) => `${check.id}: ${check.detail}`);
  return answer("pass", {
    headSha,
    summary: clip(summary.join("; "), SUMMARY_LIMIT),
  });
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

// Waits on the PR's required checks for the head.
async function ciStatus(ops: Ops, payload: Payload): Promise<Outcome> {
  const { pr, expectedSha, minutes } = CI.parse(payload);
  const done = await opOf(ops, "ci-status", { pr, expectedSha }, minutes);
  if (!done.ok) {
    return done;
  }
  const reply = ciReplyOf(recordOf(done.reply));
  switch (reply.kind) {
    case "failed":
      return {
        ok: false,
        error: reply.error ?? "CI's status could not be read",
      };
    case "pass":
      return answer("green");
    case "pending":
    case "no-checks":
    case "moved":
      return answer(reply.kind);
    case "fail":
      return ciFailed(ops, { pr, expectedSha }, reply);
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

async function ciFailed(
  ops: Ops,
  { pr, expectedSha }: { pr: number | null; expectedSha: string },
  { failing, logPath }: { failing: readonly string[]; logPath: string },
): Promise<Outcome> {
  const names = failing.join(", ");
  const body = `Required checks failed on ${expectedSha.slice(0, SHORT_SHA)}: ${names}.`;
  const comment = await posted(ops, pr, [{ by: stepBy(ops, "CI"), body }]);
  if (!comment.ok) {
    return comment;
  }
  return answer("fail", {
    failure: `CI checks failed: ${names}\nFailed-job logs: ${logPath}`,
  });
}

// The `checks` entry's checks for the run from `entry`, with ops through
// `effects`.
function checksEntryChecks(entry: Entry, effects: JobEffects): Checks {
  const { issue, jobId, models } = entry.context;
  const ops: Ops = { number: issue, jobId, models, effects };
  return {
    "checks-work?": (payload: Payload) => guarded(() => checksWork(payload)),
    "wiki-check": (payload: Payload) => guarded(() => wikiCheck(ops, payload)),
    verify: (payload: Payload) => guarded(() => verify(ops, payload)),
    "ci-status": (payload: Payload) => guarded(() => ciStatus(ops, payload)),
    "ci-fixer-reply": (payload: Payload) => guarded(() => fixStatus(payload)),
    "check-fix-review": (payload: Payload) =>
      guarded(() => fixReview(ops, payload)),
  };
}

export { checksEntryChecks };
