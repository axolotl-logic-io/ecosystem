// @ts-check
// The checks the job runs for the implementor's `checks` entry (#420): the
// wiki check, local verification and the CI wait each run their op, with the
// timeouts verify and the CI wait need, post their comments on the PR, and
// answer with the machine's result names; a failed op fails the check, for
// the runner to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip } from "../src/workflow/clip.ts";
import {
  answerOf,
  checksWith,
  commentsOf,
  opNamed,
} from "./implementor-checks-ops-kit.mjs";
import { HEAD, PR } from "./implementor-checks-test-kit.mjs";
import { ISSUE } from "./implementor-role-test-kit.mjs";

const CODE = { code: true, wiki: false };
const BOTH = { code: true, wiki: true };
const WIKI = { code: false, wiki: true };
const VERIFY_MINUTES = 120;
// The test config's ciWaitMinutes, 30, plus ten.
const CI_MINUTES = 40;
const SUMMARY_LIMIT = 1500;
const STACKED_ON = { issue: 6, headSha: "ccccccc" };
const LINT_OK = { id: "lint", pass: true, detail: "ok" };
const TESTS_OK = { id: "test", pass: true, detail: "12 passed" };
const LINT_BAD = {
  id: "lint",
  pass: false,
  detail: "1 error",
  log: "/runs/issue-7/lint.log",
  tail: "src/a.ts:3 unused",
};
const LINT_LINE =
  "- lint: 1 error (log: /runs/issue-7/lint.log)\nsrc/a.ts:3 unused";
const VERIFY = { headSha: HEAD, testsOnly: false, pr: PR };
const CI = { pr: PR, expectedSha: HEAD, minutes: CI_MINUTES };

/** @param {{ pass: boolean }[]} checks @param {string} [headSha] @returns {Record<string, unknown>} the verify op's reply */
function verified(checks, headSha = HEAD) {
  const pass = checks.every((check) => check.pass);
  return { ok: true, headSha, pass, checks };
}

test("checks-work? answers verified for a verified head that changes code, and work otherwise", async () => {
  const { run, ops } = checksWith();
  /** @type {Record<string, unknown>[]} */
  const payloads = [
    { headSha: HEAD, verifiedSha: HEAD, flows: CODE },
    { headSha: HEAD, verifiedSha: null, flows: CODE },
    { headSha: HEAD, verifiedSha: "ccccccc", flows: CODE },
    { headSha: "", verifiedSha: "", flows: CODE },
    { headSha: HEAD, verifiedSha: HEAD, flows: WIKI },
  ];
  const outcomes = await Promise.all(
    payloads.map((payload) => run("checks-work?", payload)),
  );
  assert.deepEqual(
    outcomes.map((outcome) => answerOf(outcome).name),
    ["verified", "work", "work", "work", "work"],
  );
  assert.deepEqual(ops, []);
});

test("wiki-check runs no op for an issue that leaves the wiki alone", async () => {
  const { run, ops } = checksWith();
  const outcome = await run("wiki-check", { flows: CODE, headSha: HEAD });
  assert.equal(answerOf(outcome).name, "pass");
  assert.deepEqual(ops, []);
});

test("wiki-check checks the wiki pages, and a passing wiki-only change answers wiki-only", async () => {
  const pass = { "wiki-check": { ok: true, pass: true, checks: [] } };
  const both = checksWith(pass);
  const code = await both.run("wiki-check", { flows: BOTH, headSha: HEAD });
  assert.equal(answerOf(code).name, "pass");
  assert.equal(opNamed(both.ops, "wiki-check")?.payload.get("number"), ISSUE);
  const wiki = checksWith(pass);
  const only = await wiki.run("wiki-check", { flows: WIKI, headSha: HEAD });
  assert.equal(answerOf(only).name, "wiki-only");
});

test("failing wiki pages answer fail with the failed checks' lines", async () => {
  const links = {
    id: "links",
    pass: false,
    detail: "2 broken",
    log: "/runs/l.log",
  };
  const { run } = checksWith({
    "wiki-check": { ok: true, pass: false, checks: [links] },
  });
  const outcome = answerOf(
    await run("wiki-check", { flows: BOTH, headSha: HEAD }),
  );
  assert.deepEqual(outcome, {
    name: "fail",
    reply: { failure: "- links: 2 broken (log: /runs/l.log)" },
  });
});

test("verify runs the verify op for two hours with testsOnly, and passes with the head and the clipped summary", async () => {
  const { run, ops } = checksWith({ verify: verified([LINT_OK, TESTS_OK]) });
  const outcome = answerOf(await run("verify", VERIFY));
  assert.deepEqual(outcome, {
    name: "pass",
    reply: { headSha: HEAD, summary: "lint: ok; test: 12 passed" },
  });
  const op = opNamed(ops, "verify");
  assert.ok(op !== undefined, "the verify op ran");
  assert.equal(op.minutes, VERIFY_MINUTES);
  assert.equal(op.payload.get("number"), ISSUE);
  assert.equal(op.payload.get("testsOnly"), false);
  assert.equal(op.payload.has("stackedOn"), false);
});

test("verify passes testsOnly and what a stacked issue is stacked on to the op", async () => {
  const { run, ops } = checksWith({ verify: verified([LINT_OK]) });
  await run("verify", { ...VERIFY, testsOnly: true, stackedOn: STACKED_ON });
  const op = opNamed(ops, "verify");
  assert.equal(op?.payload.get("testsOnly"), true);
  assert.deepEqual(op?.payload.get("stackedOn"), STACKED_ON);
});

test("verify clips a long summary to 1500 characters", async () => {
  const checks = Array.from({ length: 100 }, (_, n) => ({
    id: `check-${n}`,
    pass: true,
    detail: "passed in a while",
  }));
  const { run } = checksWith({ verify: verified(checks) });
  const { reply } = answerOf(await run("verify", VERIFY));
  const joined = checks
    .map((check) => `${check.id}: ${check.detail}`)
    .join("; ");
  assert.deepEqual(reply, {
    headSha: HEAD,
    summary: clip(joined, SUMMARY_LIMIT),
  });
});

test("verify posts the checks' table on the PR, and a failure answers fail with the failed checks' lines", async () => {
  const { run, ops } = checksWith({ verify: verified([LINT_BAD, TESTS_OK]) });
  const outcome = answerOf(await run("verify", VERIFY));
  assert.deepEqual(outcome, { name: "fail", reply: { failure: LINT_LINE } });
  const [comment] = commentsOf(ops);
  assert.ok(comment !== undefined, "a comment was posted");
  assert.equal(comment.number, PR);
  const body = String(comment.body);
  assert.ok(body.startsWith(`Ran the repo's commands on ${HEAD}.`), body);
  assert.ok(body.includes("- ❌ lint: 1 error"), body);
  assert.ok(body.includes("- ✅ test: 12 passed"), body);
});

test("verify answers moved when the op checked another head", async () => {
  const { run } = checksWith({ verify: verified([LINT_OK], "ccccccc") });
  assert.equal(answerOf(await run("verify", VERIFY)).name, "moved");
});

test("an op that fails fails its check", async () => {
  const down = { ok: false, error: "fetch failed" };
  /** @type {[string, Record<string, unknown>][]} */
  const cases = [
    ["verify", VERIFY],
    ["ci-status", CI],
    ["wiki-check", { flows: BOTH, headSha: HEAD }],
  ];
  const outcomes = await Promise.all(
    cases.map(async ([name, payload]) => {
      const { run, ops } = checksWith({ [name]: down });
      const outcome = await run(name, payload);
      return { ok: outcome.ok, ran: opNamed(ops, name) !== undefined };
    }),
  );
  assert.deepEqual(
    outcomes,
    cases.map(() => ({ ok: false, ran: true })),
  );
});

test("ci-status waits on CI for the head with the payload's minutes, and answers each status", async () => {
  const cases = [
    ["pass", "green"],
    ["pending", "pending"],
    ["no-checks", "no-checks"],
    ["moved", "moved"],
  ];
  const answered = await Promise.all(
    cases.map(async ([status]) => {
      const { run, ops } = checksWith({
        "ci-status": { ok: true, status, headSha: "ccccccc" },
      });
      const { name } = answerOf(await run("ci-status", CI));
      const op = opNamed(ops, "ci-status");
      return {
        name,
        minutes: op?.minutes,
        pr: op?.payload.get("pr"),
        expectedSha: op?.payload.get("expectedSha"),
        comments: commentsOf(ops).length,
      };
    }),
  );
  assert.deepEqual(
    answered,
    cases.map(([, name]) => ({
      name,
      minutes: CI_MINUTES,
      pr: PR,
      expectedSha: HEAD,
      comments: 0,
    })),
  );
});

test("failing CI posts the failed checks on the PR and answers fail with their names and logs", async () => {
  const { run, ops } = checksWith({
    "ci-status": {
      ok: true,
      status: "fail",
      failing: ["build", "lint"],
      logPath: "/runs/issue-7/ci.log",
    },
  });
  const outcome = answerOf(await run("ci-status", CI));
  assert.deepEqual(outcome, {
    name: "fail",
    reply: {
      failure:
        "CI checks failed: build, lint\nFailed-job logs: /runs/issue-7/ci.log",
    },
  });
  const [comment] = commentsOf(ops);
  assert.equal(comment?.number, PR);
  assert.equal(
    comment?.body,
    `Required checks failed on ${HEAD}: build, lint.`,
  );
});
