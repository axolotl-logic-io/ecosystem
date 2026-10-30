// Verify's wait for the required CI on the head it reviews, with GitHub's
// answers and the pauses between them faked.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Check,
  PullRequest,
} from "@ecosystem/task-runtime/issue/recovery";
import type { CiWait } from "../../src/ci.ts";
import { requiredCi } from "../../src/ci.ts";

const SHA_LENGTH = 40;
const HEAD = "a".repeat(SHA_LENGTH);
const MOVED = "b".repeat(SHA_LENGTH);
const PAUSE_MS = 30_000;
const LIMIT_MS = 90_000;
const NO_VERDICT = /had no verdict after 90 seconds/u;
const HEAD_MOVED = /head moved from a{40} to b{40}/u;

function pullAt(head: string, checks: Check[]): PullRequest {
  return {
    number: 8,
    author: "hippy-dev",
    state: "OPEN",
    isDraft: false,
    head: "agent/issue-7",
    headSha: head,
    base: "main",
    title: "Count the widgets",
    body: "Closes #7",
    reviews: [],
    threads: [],
    checks,
  };
}

function check(bucket: string): Check {
  return { name: "ci", state: bucket.toUpperCase(), bucket };
}

// A wait whose reads answer `answers` in turn, the last one from then on,
// and which records each pause it takes.
function waitOn(
  answers: PullRequest[],
  requireCi = true,
): { wait: CiWait; paused: number[] } {
  const paused: number[] = [];
  let read = 0;
  const wait: CiWait = {
    head: HEAD,
    read: (): PullRequest | null => {
      const answer = answers[Math.min(read, answers.length - 1)] ?? null;
      read += 1;
      return answer;
    },
    requireCi,
    pauseMs: PAUSE_MS,
    limitMs: LIMIT_MS,
    sleep: (ms: number): Promise<void> => {
      paused.push(ms);
      return Promise.resolve();
    },
    checkStop: (): void => undefined,
  };
  return { wait, paused };
}

test("required CI still running is waited for until it passes", async () => {
  const { wait, paused } = waitOn([
    pullAt(HEAD, [check("pending")]),
    pullAt(HEAD, [check("pending")]),
    pullAt(HEAD, [check("pass")]),
  ]);
  const verdict = await requiredCi(wait);
  assert.equal(verdict.state, "clear");
  assert.deepEqual(paused, [PAUSE_MS, PAUSE_MS]);
});

test("a failing or cancelled required check is a failing verdict at once", async () => {
  const failed = { ...check("fail"), name: "build" };
  const { wait, paused } = waitOn([
    pullAt(HEAD, [failed, check("cancel"), check("pending")]),
  ]);
  const { pull: _pull, ...verdict } = await requiredCi(wait);
  assert.deepEqual(verdict, { state: "failing", failing: ["build", "ci"] });
  assert.deepEqual(paused, []);
});

test("no required check reported is no verdict while the repository requires CI", async () => {
  const { wait, paused } = waitOn([pullAt(HEAD, [])]);
  await assert.rejects(requiredCi(wait), NO_VERDICT);
  assert.deepEqual(paused, [PAUSE_MS, PAUSE_MS, PAUSE_MS]);
});

test("no required check reported is clear when the repository doesn't require CI", async () => {
  const { wait } = waitOn([pullAt(HEAD, [])], false);
  const verdict = await requiredCi(wait);
  assert.equal(verdict.state, "clear");
});

test("a head that moves during the wait ends it", async () => {
  const { wait } = waitOn([
    pullAt(HEAD, [check("pending")]),
    pullAt(MOVED, [check("pass")]),
  ]);
  await assert.rejects(requiredCi(wait), HEAD_MOVED);
});
