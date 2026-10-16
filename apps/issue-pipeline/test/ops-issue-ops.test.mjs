// @ts-check
// The save-state, ask and stop ops through the ops CLI: their replies, and
// what each shows on GitHub (comments, the state comment, labels, closed
// claims). The split op is in ops-split.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STOPS } from "../src/stops.ts";
import { bodyOf, effectNames, stateOf } from "./gh-effects.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  effects,
  reply,
  root,
  sh,
  stateComment,
  TIME,
  writes,
} from "./ops-cli-test-kit.mjs";

/** @import { Stop } from "../src/stops.ts" */

const LIVE = new Date().toISOString();
const CLAIM_MARK = "<!-- agent-pipeline:claim-closed lane=me sweep=s1 -->";
// Each test's issue, and the comments and PRs it meets.
const SAVED = { n: 50 };
const SAVE_REPLY = { ok: true, op: "save-state", posted: 0 };
const ASKED = { n: 51, state: 5, claim: 6 };
const STOPPED = { n: 53, pr: 70, claim: 8 };
const STOPPED_BY_REASON = { n: 54 };

sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

/** @param {number} id @returns {object} */
function myClaim(id) {
  return claimComment(id, "me", "s1", LIVE);
}

/** @param {string} code @returns {Stop} */
function stopOf(code) {
  const stop = STOPS.find((item) => item.code === code);
  if (stop === undefined) {
    throw new Error(`no stop ${code}`);
  }
  return stop;
}

// What a stop comment leaves out of what `stop-labels` promises it names:
// the control (beside its label), what it checks and the reason.
/** @param {string} body @param {string} code @param {string} reason @returns {string[]} */
function missingStopFacts(body, code, reason) {
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

test("save-state writes the state it is given, and nothing without one", () => {
  const { n } = SAVED;
  const state = { stage: "plan", pr: null };
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: n, state }), SAVE_REPLY);
  const saved = effects();
  assert.deepEqual(effectNames(saved), [`comment #${n} state`]);
  assert.deepEqual(stateOf(saved, `comment #${n} state`), state);
  reply([]);
  assert.deepEqual(askOps({ op: "save-state", number: n }), SAVE_REPLY);
  assert.deepEqual(writes(), []);
});

test("ask posts numbered questions, parks the issue and closes its claims", () => {
  const { n, state, claim } = ASKED;
  const comments = [stateComment(state, { stage: "plan" }), myClaim(claim)];
  reply([{ ...commentsReply(n, comments), keep: true }]);
  const request = {
    op: "ask",
    number: n,
    questions: ["Which X?", "Why Y?"],
    state: { stage: "plan", pr: null },
    by: null,
  };
  assert.deepEqual(askOps(request), { ok: true, op: "ask", posted: 0 });
  const asked = effects();
  assert.deepEqual(effectNames(asked), [
    `comment #${n} role=triage`,
    `edit comment ${state} state`,
    `edit comment ${claim} role=claim`,
    `label #${n} agent:needs-info`,
    `unlabel #${n} agent:working`,
  ]);
  const questions = bodyOf(asked, `comment #${n} role=triage`);
  assert.ok(questions.includes("1. Which X?\n2. Why Y?"));
  assert.deepEqual(stateOf(asked, `edit comment ${state} state`), {
    stage: "triage",
    pr: null,
    questionsAt: TIME,
    lease: null,
  });
  assert.ok(
    bodyOf(asked, `edit comment ${claim} role=claim`).includes(CLAIM_MARK),
  );
});

test("stop by code explains the control on the issue and its PR and swaps labels", () => {
  const { n, pr, claim } = STOPPED;
  reply([
    {
      when: `issues/${n}/labels`,
      stdout: JSON.stringify([{ name: "agent:stopped-error" }]),
    },
    { ...commentsReply(n, [myClaim(claim)]), keep: true },
  ]);
  const request = {
    op: "stop",
    number: n,
    code: "budget",
    reason: "over budget",
    detail: "the details",
    nextStep: "the next step",
    state: { stage: "review", pr },
  };
  const label = "agent:stopped-budget";
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "budget",
    label,
  });
  const stopped = effects();
  assert.deepEqual(effectNames(stopped), [
    `comment #${n} role=coordinator`,
    `comment #${n} state`,
    `comment #${pr} role=coordinator`,
    `edit comment ${claim} role=claim`,
    `label #${n} ${label}`,
    `label #${pr} ${label}`,
    `unlabel #${n} agent:stopped-error`,
    `unlabel #${n} agent:working`,
    `unlabel #${pr} agent:working`,
  ]);
  for (const target of [n, pr]) {
    const body = bodyOf(stopped, `comment #${target} role=coordinator`);
    assert.deepEqual(missingStopFacts(body, "budget", "over budget"), []);
    assert.ok(body.includes("the details") && body.includes("the next step"));
  }
  assert.deepEqual(stateOf(stopped, `comment #${n} state`), {
    stage: "stopped",
    pr,
    lease: null,
    stopCode: "budget",
    stopReason: "over budget",
  });
  assert.ok(
    bodyOf(stopped, `edit comment ${claim} role=claim`).includes(CLAIM_MARK),
  );
});

test("stop by reason, with no detail, next step or PR, says how to resume", () => {
  const { n } = STOPPED_BY_REASON;
  reply([]);
  const request = {
    op: "stop",
    number: n,
    code: null,
    reason: "could not push",
    detail: "",
    nextStep: null,
    state: { stage: "implement" },
  };
  const label = "agent:stopped-push-rejected";
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "stop",
    posted: 0,
    code: "push-rejected",
    label,
  });
  const stopped = effects();
  assert.deepEqual(effectNames(stopped), [
    `comment #${n} role=coordinator`,
    `comment #${n} state`,
    `label #${n} ${label}`,
    `unlabel #${n} agent:working`,
  ]);
  const body = bodyOf(stopped, `comment #${n} role=coordinator`);
  assert.deepEqual(
    missingStopFacts(body, "push-rejected", "could not push"),
    [],
  );
  assert.ok(body.includes("To resume") && body.includes(`remove \`${label}\``));
  assert.deepEqual(stateOf(stopped, `comment #${n} state`), {
    stage: "stopped",
    lease: null,
    stopCode: "push-rejected",
    stopReason: "could not push",
  });
});
