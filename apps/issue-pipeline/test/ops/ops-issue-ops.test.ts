// The ask and stop ops through the ops CLI on version 2 states:
// their replies, and what each shows on GitHub (comments, the state comment,
// labels, closed claims). The save-spec op went with the spec writer: the
// author posts the Gherkin itself (author-role.test.mjs). save-state is in
// ops-save-state.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stop } from "../../src/stops.ts";
import { bodyOf, effectNames, stateOf } from "../gh-effects-test-kit.ts";
import {
  commentWriteReplies,
  labelReplies,
  stopMutationReplies,
} from "../gh-mutation-fixtures.ts";
import { kit, reviewStopReplies, v2State } from "../ops-v2-test-kit.ts";

kit.requireGhReplies();

const { STOPS }: typeof import("../../src/stops.ts") = await import(
  "../../src/stops.ts"
);
const {
  askOps,
  claimComment,
  commentsReply,
  effects,
  reply,
  stateComment,
  TIME,
  writes,
}: typeof import("../ops-cli-test-kit.ts") = kit;

const LIVE = new Date().toISOString();
const CLAIM_MARK = "<!-- agent-pipeline:claim-closed lane=me sweep=s1 -->";
// Each test's issue, and the comments and PRs it meets.
const ASKED = { n: 51, state: 5, claim: 6 };
// The trusted-inputs revision the job records the questions were asked at.
const INPUTS_LENGTH = 64;
const ASKED_INPUTS = { inputs: "a".repeat(INPUTS_LENGTH) };
const STOPPED = { n: 53, pr: 70, claim: 8 };
const STOPPED_BY_REASON = { n: 54 };
const MERGED_STOP = { n: 56, pr: 9, state: 12 };
const SHA_LENGTH = 40;
const CODE_MERGED: { pr: number; sha: string } = {
  pr: MERGED_STOP.pr,
  sha: "b".repeat(SHA_LENGTH),
};

function myClaim(id: number): object {
  return claimComment(id, "me", "s1", LIVE);
}

function stopOf(code: string): Stop {
  const stop = STOPS.find((item) => item.code === code);
  if (stop === undefined) {
    throw new Error(`no stop ${code}`);
  }
  return stop;
}

// What a stop comment leaves out of what `stop-labels` promises it names:
// the control (beside its label), what it checks and the reason.
function missingStopFacts(
  body: string,
  code: string,
  reason: string,
): string[] {
  const { control, explain, label } = stopOf(code);
  const named = `\`${label.name}\``;
  const facts = {
    marker: "<!-- agent-pipeline:comment role=coordinator -->",
    label: named,
    checks: explain,
    reason: `Reason: ${reason}`,
  };
  const missing = Object.entries(facts)
    .filter(([, text]) => !body.includes(text))
    .map(([fact]) => fact);
  const lines = body.split("\n");
  if (!lines.some((line) => line.includes(control) && line.includes(named))) {
    missing.push("control");
  }
  return missing;
}

// Issue `n`'s state stopped at review by `code` for `reason`, with `extra`
// over it.
function stoppedAt(
  n: number,
  code: string,
  reason: string,
  extra: object = {},
): Record<string, unknown> {
  return v2State(n, {
    stage: "stopped",
    stoppedStage: "review",
    stopCode: code,
    log: [`${TIME} stopped (${code}): ${reason}`],
    ...extra,
  });
}

test("ask posts numbered questions as the author, parks the issue at the author and closes its claims", () => {
  const { n, state, claim } = ASKED;
  const before = v2State(n, {
    stage: "author",
    lease: { lane: "me", sweepId: "s1", at: TIME },
  });
  const comments = [stateComment(state, before), myClaim(claim)];
  reply([
    { ...commentsReply(n, comments), keep: true },
    ...commentWriteReplies("o/r", n, [state, claim]),
    ...labelReplies("o/r", n, ["agent:needs-info"], ["agent:working"]),
  ]);
  const given = { ...before, asked: ASKED_INPUTS };
  const request = {
    op: "ask",
    number: n,
    questions: ["Which X?", "Why Y?"],
    state: given,
    by: { role: "author", agent: null, model: null, run: null },
  };
  const parked = { ...given, lease: null };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "ask",
    posted: 0,
    commentIds: [],
    state: parked,
  });
  const asked = effects();
  assert.deepEqual(effectNames(asked), [
    `comment #${n} role=author`,
    `edit comment ${state} state`,
    `edit comment ${claim} role=claim`,
    `label #${n} agent:needs-info`,
    `unlabel #${n} agent:working`,
  ]);
  const questions = bodyOf(asked, `comment #${n} role=author`);
  assert.ok(questions.includes("1. Which X?\n2. Why Y?"));
  assert.deepEqual(stateOf(asked, `edit comment ${state} state`), parked);
  assert.ok(
    bodyOf(asked, `edit comment ${claim} role=claim`).includes(CLAIM_MARK),
  );
});

// #457: an ask with no state would leave the issue's state stripped, so it
// is refused before it posts.
test("ask without a state is refused and changes nothing on GitHub", () => {
  reply([]);
  const request = {
    op: "ask",
    number: ASKED.n,
    questions: ["Which X?"],
    by: { role: "author" },
  };
  assert.partialDeepStrictEqual(askOps(request), { ok: false });
  assert.deepEqual(writes(), []);
});

test("stop by code explains the control on the issue and its PR and swaps labels", () => {
  const { n, pr, claim } = STOPPED;
  reviewStopReplies(n, pr, claim);
  const request = {
    op: "stop",
    number: n,
    code: "review-rounds",
    reason: "too many rounds",
    detail: "the details",
    nextStep: "the next step",
    state: v2State(n, { stage: "review", pr }),
  };
  const label = "agent:stopped-review-rounds";
  const state = stoppedAt(n, "review-rounds", "too many rounds", { pr });
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    commentIds: [],
    code: "review-rounds",
    label,
    state,
  });
  const stopped = effects();
  assert.deepEqual(effectNames(stopped), [
    `comment #${n} role=coordinator`,
    `comment #${pr} role=coordinator`,
    `edit comment ${n} state`,
    `edit comment ${claim} role=claim`,
    `label #${n} ${label}`,
    `label #${pr} ${label}`,
    `unlabel #${n} agent:stopped-error`,
    `unlabel #${n} agent:working`,
    `unlabel #${pr} agent:working`,
  ]);
  for (const target of [n, pr]) {
    const body = bodyOf(stopped, `comment #${target} role=coordinator`);
    assert.deepEqual(
      missingStopFacts(body, "review-rounds", "too many rounds"),
      [],
    );
    assert.ok(body.includes("the details") && body.includes("the next step"));
  }
  assert.deepEqual(stateOf(stopped, `edit comment ${n} state`), state);
  assert.ok(
    bodyOf(stopped, `edit comment ${claim} role=claim`).includes(CLAIM_MARK),
  );
});

test("stop by reason, with no detail, next step or PR, says how to resume", () => {
  const { n } = STOPPED_BY_REASON;
  reply([
    ...stopMutationReplies(n, { stateId: n, pr: null, code: "push-rejected" }),
    {
      ...commentsReply(n, [stateComment(n, v2State(n, { stage: "review" }))]),
      persistState: true,
      keep: true,
    },
  ]);
  const request = {
    op: "stop",
    number: n,
    code: null,
    reason: "could not push",
    detail: "",
    nextStep: null,
    state: v2State(n, { stage: "review" }),
  };
  const label = "agent:stopped-push-rejected";
  const state = stoppedAt(n, "push-rejected", "could not push");
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    commentIds: [],
    code: "push-rejected",
    label,
    state,
  });
  const stopped = effects();
  assert.deepEqual(effectNames(stopped), [
    `comment #${n} role=coordinator`,
    `edit comment ${n} state`,
    `label #${n} ${label}`,
    `unlabel #${n} agent:working`,
  ]);
  const body = bodyOf(stopped, `comment #${n} role=coordinator`);
  assert.deepEqual(
    missingStopFacts(body, "push-rejected", "could not push"),
    [],
  );
  assert.ok(body.includes("To resume") && body.includes(`remove \`${label}\``));
  assert.deepEqual(stateOf(stopped, `edit comment ${n} state`), state);
});

// Version 2 has no publish stage: once the code merged, the stop keeps the
// stage it came from and says how the next job resumes on the merged result.
test("a stop after the code merged keeps its stage and resumes on the merged result", () => {
  const { n, pr, state: stateId } = MERGED_STOP;
  const saved = v2State(n, { stage: "merge", pr, codeMerged: CODE_MERGED });
  reply([
    {
      ...commentsReply(n, [stateComment(stateId, saved)]),
      keep: true,
      persistState: true,
    },
    ...stopMutationReplies(n, { stateId, pr, code: "conflict" }),
  ]);
  const request = {
    op: "stop",
    number: n,
    code: "conflict",
    reason: "the conflict resolution was rejected",
    state: saved,
  };
  const label = "agent:stopped-conflict";
  assert.partialDeepStrictEqual(askOps(request), {
    ok: true,
    code: "conflict",
    label,
  });
  const stopped = effects();
  const body = bodyOf(stopped, `comment #${n} role=coordinator`);
  assert.ok(body.includes(`remove \`${label}\``));
  assert.partialDeepStrictEqual(
    stateOf(stopped, `edit comment ${stateId} state`),
    { stage: "stopped", stoppedStage: "merge", codeMerged: CODE_MERGED },
  );
});
