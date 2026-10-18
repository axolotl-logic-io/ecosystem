// @ts-check
// The implementor role's `checks` entry (#420; the wiki's
// Pipeline-Roles-Implementor, "Entry `checks`"): every edge as a state and a
// result, every op and check naming the issue, the payloads its checks and
// ops carry, and the table's sessions, limits and faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, TABLE } from "../src/roles/implementor/machine.ts";
import { checkTable } from "../src/roles/machine.ts";
import { ALL_LENSES } from "../src/workflow/lenses.ts";
import { CHECKS_EDGES } from "./implementor-checks-edge-fixtures.mjs";
import { FIX_EDGES } from "./implementor-checks-fix-edge-fixtures.mjs";
import {
  CANNOT_FIX,
  checksData,
  checksLocated,
  checksStep,
  effectAt,
  FIXED,
  fieldOf,
  HEAD,
  PR,
} from "./implementor-checks-test-kit.mjs";
import { ISSUE, implContext, nameOf } from "./implementor-role-test-kit.mjs";

/** @import { Effect } from "../src/roles/machine.ts" */
/** @import { ChecksEdge } from "./implementor-checks-edge-fixtures.mjs" */

const STACKED_ON = { issue: 6, headSha: "ccccccc" };

/** @param {Effect} effect @returns {unknown} the effect as an edge pins it: a stop as its code and reason, else its name or end */
function pinnedOf(effect) {
  const named = nameOf(effect);
  if (typeof named === "string" || named.kind !== "stopped") {
    return named;
  }
  const { reason } = named.after?.payload ?? {};
  return { stop: named.code, reason };
}

/** @param {ChecksEdge} edge @returns {unknown} the effect the edge expects */
function expectedOf(edge) {
  return edge.effect;
}

/** @param {Effect} effect @returns {Map<string, unknown>} an op's or check's payload */
function payloadOf(effect) {
  if (effect.kind !== "op" && effect.kind !== "check") {
    throw new Error(`a ${effect.kind}, not an op or a check`);
  }
  return new Map(Object.entries(effect.payload));
}

test("every edge of the checks entry gives its next state, effect and data", () => {
  for (const edge of [...CHECKS_EDGES, ...FIX_EDGES]) {
    const label = `${edge.at} ${edge.result}`;
    const step = checksStep(edge.at, edge.result, edge.reply, edge.data);
    assert.equal(step.state.at, edge.next, label);
    assert.deepEqual(pinnedOf(step.effect), expectedOf(edge), label);
    for (const [field, value] of Object.entries(edge.changes ?? {})) {
      assert.deepEqual(fieldOf(step, field), value, `${label} ${field}`);
    }
  }
});

test("the start names the checks entry, and every op and check of the entry names the issue", () => {
  const { data } = checksLocated();
  assert.equal(data.entry, "checks");
  assert.equal(
    payloadOf(TABLE.states.start.effect(data)).get("entry"),
    "checks",
  );
  const named = [...CHECKS_EDGES, ...FIX_EDGES]
    .map((edge) => checksStep(edge.at, edge.result, edge.reply, edge.data))
    .filter(({ effect }) => effect.kind === "op" || effect.kind === "check")
    .map(({ effect }) => payloadOf(effect).get("number"));
  assert.ok(named.length > 10);
  assert.deepEqual(new Set(named), new Set([ISSUE]));
});

test("checks-work? is given the head, the verified head and the flows", () => {
  const payload = payloadOf(effectAt("checks-work?", { verifiedSha: HEAD }));
  assert.equal(payload.get("headSha"), HEAD);
  assert.equal(payload.get("verifiedSha"), HEAD);
  assert.deepEqual(payload.get("flows"), { code: true, wiki: false });
});

test("verify is given the head, testsOnly, the PR and, only for a stacked issue, what it is stacked on", () => {
  const plain = payloadOf(effectAt("verify", { testsOnly: true }));
  assert.equal(plain.get("headSha"), HEAD);
  assert.equal(plain.get("testsOnly"), true);
  assert.equal(plain.get("pr"), PR);
  assert.equal(plain.has("stackedOn"), false);
  const stacked = payloadOf(effectAt("verify", { stackedOn: STACKED_ON }));
  assert.equal(stacked.get("testsOnly"), false);
  assert.deepEqual(stacked.get("stackedOn"), STACKED_ON);
});

test("ci-status is given the PR, the head CI must be on and the config's wait plus ten minutes", () => {
  const payload = payloadOf(effectAt("ci-status"));
  assert.equal(payload.get("pr"), PR);
  assert.equal(payload.get("expectedSha"), HEAD);
  assert.equal(payload.get("minutes"), implContext().cfg.ciWaitMinutes + 10);
});

test("the fix's push posts the fixer's summary on the PR, and its review diff is since the reviewed head, tagged by round", () => {
  const push = checksStep("ci-fixer-reply", "fixed", null, {
    fix: FIXED,
    ciFixRounds: 1,
  });
  const comments = payloadOf(push.effect).get("comments");
  assert.ok(Array.isArray(comments) && comments.length === 1, "one comment");
  const [comment] = comments;
  assert.equal(comment.number, PR);
  assert.ok(String(comment.body).includes(FIXED.summary), comment.body);
  const prepare = payloadOf(effectAt("prepare-fix-review", { ciFixRounds: 1 }));
  assert.equal(prepare.get("sinceSha"), HEAD);
  assert.equal(prepare.get("tag"), "cifix1");
  const stacked = payloadOf(
    effectAt("prepare-fix-review", { ciFixRounds: 2, stackedOn: STACKED_ON }),
  );
  assert.equal(stacked.get("tag"), "cifix2");
  assert.deepEqual(stacked.get("stackedOn"), STACKED_ON);
});

test("the fixer's reply check gets the fix, and the review check gets both reviews, the head and the PR", () => {
  const reply = payloadOf(effectAt("ci-fixer-reply", { fix: CANNOT_FIX }));
  assert.deepEqual(reply.get("fix"), CANNOT_FIX);
  const reviews = [{ lens: "correctness", reply: { findings: [] } }];
  const review = payloadOf(effectAt("check-fix-review", { reviews }));
  assert.deepEqual(review.get("reviews"), reviews);
  assert.equal(review.get("headSha"), HEAD);
  assert.equal(review.get("pr"), PR);
});

test("the table runs the checks entry's three sessions beside the implementer, the fix entry's and the start sync's, sends no PR op and has no faults under limits with maxCiFixes", () => {
  const sessions = Object.entries(TABLE.states)
    .filter(([, spec]) => spec.kind === "session")
    .map(([name]) => name);
  assert.deepEqual(
    new Set(sessions),
    new Set([
      "implementer",
      "fixer",
      ...ALL_LENSES.map((lens) => `rereview-${lens}`),
      "resolver",
      "ci-fixer",
      "check-fix-correctness",
      "check-fix-scope",
    ]),
  );
  const sent = [...CHECKS_EDGES, ...FIX_EDGES]
    .map(
      (edge) => checksStep(edge.at, edge.result, edge.reply, edge.data).effect,
    )
    .map(nameOf)
    .filter((name) => typeof name === "string");
  for (const prOp of ["op:open-pr", "op:start-pr", "op:close-pr"]) {
    assert.equal(sent.includes(prOp), false, prOp);
  }
  assert.deepEqual(TABLE.entries, ["start"]);
  assert.deepEqual(LIMITS, {
    maxContinuations: 1,
    maxFixRounds: 2,
    maxConflictFixes: 2,
    maxSyncs: 3,
    maxCiFixes: 2,
  });
  assert.deepEqual(checkTable(TABLE, LIMITS, checksData()), []);
});
