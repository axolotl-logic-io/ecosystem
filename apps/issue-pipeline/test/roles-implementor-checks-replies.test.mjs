// @ts-check
// The checks that read the `checks` entry's session replies (#420): the CI
// fixer's status, and the two check-fix reviews, whose comments go on the PR
// and whose blocking findings send the fix back to the fixer.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerOf,
  checksWith,
  commentsOf,
} from "./implementor-checks-ops-kit.mjs";
import {
  BLOCKING_REVIEW,
  CANNOT_FIX,
  CLEAN_REVIEW,
  FIXED,
  FIXED_HEAD,
  HANDOFF_FIX,
  PR,
} from "./implementor-checks-test-kit.mjs";

const BLOCKING_LINE = "src/a.ts:3 Drops the error - The catch swallows it.";

/** @param {unknown} correctness @param {unknown} scope @returns {Record<string, unknown>} the review check's payload */
function reviewed(correctness, scope) {
  return {
    reviews: [
      { lens: "correctness", reply: correctness },
      { lens: "scope", reply: scope },
    ],
    headSha: FIXED_HEAD,
    pr: PR,
  };
}

test("ci-fixer-reply answers the fix's status, and bad for a reply that didn't read", async () => {
  const { run, ops } = checksWith();
  const cases = [
    [FIXED, "fixed"],
    [HANDOFF_FIX, "handoff"],
    [CANNOT_FIX, "cannot-fix"],
    [null, "bad"],
  ];
  const outcomes = await Promise.all(
    cases.map(([fix]) => run("ci-fixer-reply", { fix })),
  );
  assert.deepEqual(
    outcomes.map((outcome) => answerOf(outcome).name),
    cases.map(([, name]) => name),
  );
  assert.deepEqual(ops, []);
});

test("clean check-fix reviews post one comment per lens on the PR and answer clean", async () => {
  const { run, ops } = checksWith();
  const outcome = await run(
    "check-fix-review",
    reviewed(CLEAN_REVIEW, CLEAN_REVIEW),
  );
  assert.equal(answerOf(outcome).name, "clean");
  const comments = commentsOf(ops);
  assert.equal(comments.length, 2);
  for (const comment of comments) {
    assert.equal(comment.number, PR);
    const body = String(comment.body);
    assert.ok(body.includes(`Review of the check fix in ${FIXED_HEAD}.`), body);
    assert.ok(body.includes("No blocking findings."), body);
  }
});

test("a blocking finding in either lens answers blocking with the finding, and its comment lists it", async () => {
  const { run, ops } = checksWith();
  const outcome = answerOf(
    await run("check-fix-review", reviewed(CLEAN_REVIEW, BLOCKING_REVIEW)),
  );
  assert.equal(outcome.name, "blocking");
  const failure = JSON.stringify(outcome.reply);
  assert.ok(
    failure.includes(JSON.stringify(BLOCKING_LINE).slice(1, -1)),
    failure,
  );
  const bodies = commentsOf(ops).map((comment) => String(comment.body));
  assert.equal(bodies.length, 2);
  assert.ok(
    bodies.some((body) => body.includes("**Blocking**")),
    bodies.join("\n---\n"),
  );
});

test("a review that doesn't read answers bad", async () => {
  const { run } = checksWith();
  const broken = [null, { findings: "none" }, { findings: [{ file: 1 }] }];
  const outcomes = await Promise.all(
    broken.map((reply) =>
      run("check-fix-review", reviewed(CLEAN_REVIEW, reply)),
    ),
  );
  assert.deepEqual(
    outcomes.map((outcome) => answerOf(outcome).name),
    ["bad", "bad", "bad"],
  );
});
