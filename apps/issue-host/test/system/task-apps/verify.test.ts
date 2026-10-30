// Verify's task app, the built verify.mjs, run as a buddy runs it on a
// disposable machine: a person applied `start:verify` to an issue whose
// branch has an open PR another account opened. Only gh (fake-gh.ts) and pi
// (fake-pi.ts) are fakes; the checks, the checkout and Git are real.
//
// - Nothing but nits approves the PR's head.
// - A blocking finding, a Security finding of any severity and failing
//   required CI each request changes.
// - A rerun on a head Verify's account already reviewed reports that review
//   and submits no second one.
// - Verify's account can't review a PR it opened, so that run fails with a
//   comment and submits nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type {
  FakeComment,
  World,
} from "../../support/signals/fake-github-world.ts";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import type {
  BuddyChoice,
  Machine,
  PlannedSession,
} from "../runtime/buddy-flow-test-kit.ts";
import {
  applyStart,
  DEVELOPER,
  ISSUE,
  machine,
} from "../runtime/buddy-flow-test-kit.ts";

const BRANCH = `agent/issue-${ISSUE}`;
const PR = 8;
const VERIFIER: BuddyChoice = { account: "lawd", tasks: ["verify"] };
const REVIEW_MARK = /<!-- task-app:verify:review (?<payload>\{.*?\}) -->/u;
const REPORTED = z.strictObject({
  pr: z.number(),
  review: z.number(),
  head: z.string(),
  state: z.string(),
});

function gitIn(dir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Whether `text` contains `part`.
function has(text: string | undefined, part: string): boolean {
  return text?.includes(part) === true;
}

function reviewOf(findings: unknown[]): PlannedSession {
  return {
    commit: null,
    change: null,
    changeFirst: false,
    awaitAbort: false,
    reply: { summary: "Read the whole diff.", findings },
  };
}

// A machine whose issue has PR PR from BRANCH, opened by `author`, at a
// new head whose required CI reports `ci`, and `start:verify` applied by
// a person.
function opened(
  ci: "pass" | "fail",
  author: string = DEVELOPER,
): { box: Machine; head: string } {
  const box = machine();
  gitIn(box.work, ["checkout", "--quiet", "-b", BRANCH]);
  fs.writeFileSync(path.join(box.work, "counter.txt"), "3 widgets\n");
  gitIn(box.work, ["add", "counter.txt"]);
  gitIn(box.work, ["commit", "--quiet", "-m", "Count the widgets"]);
  gitIn(box.work, ["push", "--quiet", "origin", BRANCH]);
  const head = box.git(["rev-parse", BRANCH]);
  box.change((world) => {
    world.pulls = [
      {
        number: PR,
        head: BRANCH,
        base: "main",
        title: "Count the widgets",
        body: `Closes #${ISSUE}`,
        author,
        state: "OPEN",
        isDraft: false,
      },
    ];
    world.checks = { [head]: [{ name: "ci", bucket: ci }] };
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue !== undefined) {
      issue.labels = [];
    }
  });
  applyStart(box, "start:verify");
  return { box, head };
}

function pullOf(world: World): NonNullable<World["pulls"]>[number] {
  const pull = world.pulls?.find((item) => item.number === PR);
  if (pull === undefined) {
    throw new Error(`the world has no PR #${PR}`);
  }
  return pull;
}

function commentsOf(world: World): FakeComment[] {
  return world.issues.find((item) => item.number === ISSUE)?.comments ?? [];
}

function labelsOf(world: World): string[] {
  return world.issues.find((item) => item.number === ISSUE)?.labels ?? [];
}

// Verify's reports of a review on the issue, oldest first.
function reported(world: World): {
  comment: FakeComment;
  report: z.infer<typeof REPORTED>;
}[] {
  return commentsOf(world).flatMap((comment) => {
    const { payload } = REVIEW_MARK.exec(comment.body)?.groups ?? {};
    if (payload === undefined) {
      return [];
    }
    return [{ comment, report: REPORTED.parse(JSON.parse(payload)) }];
  });
}

function onlyReview(
  world: World,
): NonNullable<NonNullable<World["pulls"]>[number]["reviews"]>[number] {
  const [review, ...more] = pullOf(world).reviews ?? [];
  if (review === undefined || more.length > 0) {
    throw new Error("not exactly one review on the PR");
  }
  return review;
}

test("Verify approves a head with only nits, from its own account", async () => {
  const { box, head } = opened("pass");
  try {
    const ended = await box.runTaskApp("verify", VERIFIER, [
      reviewOf([
        {
          path: "counter.txt",
          line: 1,
          body: "Say widget counts in words.",
          severity: "nit",
          security: false,
        },
      ]),
    ]);
    assert.equal(ended.status, 0, ended.stderr);
    const world = box.world();
    const review = onlyReview(world);
    assert.equal(review.author, LANDING);
    assert.equal(review.state, "APPROVED");
    assert.equal(review.commitId, head);
    assert.deepEqual(
      (pullOf(world).reviewComments ?? []).map((comment) => comment.body),
      ["**Nit (non-blocking)**: Say widget counts in words."],
    );
    assert.deepEqual(box.checksRun(), [head]);
    const [report, ...more] = reported(world);
    assert.equal(more.length, 0);
    assert.deepEqual(report?.report, {
      pr: PR,
      review: review.id,
      head,
      state: "APPROVED",
    });
    assert.ok(has(report?.comment.body, "with 1 nit"));
    assert.ok(has(report?.comment.body, "`start:land`"));
    assert.deepEqual(labelsOf(world), []);
  } finally {
    box.cleanup();
  }
});

test("Verify requests changes for a blocking finding", async () => {
  const { box, head } = opened("pass");
  try {
    const ended = await box.runTaskApp("verify", VERIFIER, [
      reviewOf([
        {
          body: "The counter never resets.",
          severity: "blocking",
          security: false,
        },
      ]),
    ]);
    assert.equal(ended.status, 0, ended.stderr);
    const world = box.world();
    const review = onlyReview(world);
    assert.equal(review.state, "CHANGES_REQUESTED");
    assert.equal(review.commitId, head);
    assert.ok(has(review.body, "**Blocking**: The counter never resets."));
    const [report] = reported(world);
    assert.equal(report?.report.state, "CHANGES_REQUESTED");
    assert.ok(has(report?.comment.body, "1 blocking finding and 0 nits"));
    assert.ok(has(report?.comment.body, "`start:fix`"));
  } finally {
    box.cleanup();
  }
});

test("A Security finding blocks whatever its severity", async () => {
  const { box } = opened("pass");
  try {
    const ended = await box.runTaskApp("verify", VERIFIER, [
      reviewOf([
        {
          body: "abuse-risk: the count is read from an unauthenticated query.",
          severity: "nit",
          security: true,
        },
      ]),
    ]);
    assert.equal(ended.status, 0, ended.stderr);
    const world = box.world();
    const review = onlyReview(world);
    assert.equal(review.state, "CHANGES_REQUESTED");
    assert.ok(has(review.body, "**Security (blocking)**: abuse-risk"));
    const [report] = reported(world);
    assert.ok(
      has(
        report?.comment.body,
        "1 blocking finding, a Security finding among them, and 0 nits",
      ),
    );
  } finally {
    box.cleanup();
  }
});

test("Failing required CI requests changes", async () => {
  const { box, head } = opened("fail");
  try {
    const ended = await box.runTaskApp("verify", VERIFIER, [reviewOf([])]);
    assert.equal(ended.status, 0, ended.stderr);
    const review = onlyReview(box.world());
    assert.equal(review.state, "CHANGES_REQUESTED");
    assert.ok(review.body.includes(`Required CI failed on ${head}: ci.`));
  } finally {
    box.cleanup();
  }
});

test("A rerun on a head Verify already reviewed reports that review", async () => {
  const { box, head } = opened("pass");
  try {
    const first = await box.runTaskApp("verify", VERIFIER, [reviewOf([])]);
    assert.equal(first.status, 0, first.stderr);
    applyStart(box, "start:verify");
    const rerun = await box.runTaskApp("verify", VERIFIER, []);
    assert.equal(rerun.status, 0, rerun.stderr);
    const world = box.world();
    const review = onlyReview(world);
    assert.equal(review.state, "APPROVED");
    assert.equal(box.launches().length, 1);
    assert.deepEqual(box.checksRun(), [head]);
    const reports = reported(world);
    assert.deepEqual(
      reports.map((item) => item.report),
      [
        { pr: PR, review: review.id, head, state: "APPROVED" },
        { pr: PR, review: review.id, head, state: "APPROVED" },
      ],
    );
    assert.ok(has(reports[1]?.comment.body, "and approved it"));
    assert.ok(has(reports[1]?.comment.body, "already reviewed"));
    assert.deepEqual(labelsOf(world), []);
  } finally {
    box.cleanup();
  }
});

test("Verify can't review a PR its own account opened", async () => {
  const { box } = opened("pass", LANDING);
  try {
    const ended = await box.runTaskApp("verify", VERIFIER, []);
    assert.equal(ended.status, 1);
    const world = box.world();
    assert.deepEqual(pullOf(world).reviews ?? [], []);
    assert.equal(box.launches().length, 0);
    const failure = commentsOf(world).find(
      (comment) => comment.author === LANDING,
    );
    assert.ok(has(failure?.body, "failed at its work step"));
    assert.ok(has(failure?.body, "doesn't let a PR's author review it"));
    assert.ok(has(failure?.body, "apply `start:verify` again"));
  } finally {
    box.cleanup();
  }
});
