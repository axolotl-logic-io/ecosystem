// The built Fix app against real Git and the shared fake GitHub/model kit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import { advanceTarget, review } from "./buddy-flow-review-test-kit.ts";
import {
  applyStart,
  type BuddyChoice,
  DEVELOPER,
  type Machine,
  machine,
  type PlannedSession,
} from "./buddy-flow-test-kit.ts";

const FIXER: BuddyChoice = { role: "developer", tasks: ["fix"] };
const BRANCH = "agent/issue-7";
const PR = 19;
const ISSUE = 7;

function git(box: Machine, args: string[]): string {
  const result = spawnSync("git", ["-C", box.work, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

function opened(): { box: Machine; head: string } {
  const box = machine((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue !== undefined) {
      issue.labels = [];
    }
    world.pulls = [
      {
        number: PR,
        head: BRANCH,
        base: "main",
        title: "Count widgets",
        body: "Closes #7",
        author: DEVELOPER,
        state: "OPEN",
        isDraft: false,
        reviews: [],
        reviewComments: [],
      },
    ];
  });
  git(box, ["checkout", "-b", BRANCH]);
  fs.writeFileSync(path.join(box.work, "counter.txt"), "three widgets\n");
  git(box, ["add", "counter.txt"]);
  git(box, ["commit", "-m", "Count widgets"]);
  git(box, ["push", "origin", BRANCH]);
  const head = git(box, ["rev-parse", "HEAD"]);
  applyStart(box, "start:fix");
  return { box, head };
}

function request(
  box: Machine,
  head: string,
  bodies: string[] = ["Use a number."],
): number[] {
  return review(box, {
    pr: PR,
    head,
    author: LANDING,
    state: "CHANGES_REQUESTED",
    body: "Count in numbers.",
    comments: bodies.map((body) => ({ path: "counter.txt", line: 1, body })),
  }).threads;
}

function fixes(ids: number[]): PlannedSession {
  return {
    commit: {
      file: "counter.txt",
      content: "3 widgets\n",
      message: "Use a number",
    },
    change: null,
    changeFirst: false,
    awaitAbort: false,
    reply: {
      outcome: "done",
      summary: "Used a number.",
      replies: ids.map((comment) => ({ comment, reply: "Changed to 3." })),
    },
  };
}

function replies(box: Machine): number[] {
  return (box.world().pulls?.[0]?.reviewComments ?? [])
    .filter((comment) => comment.author === DEVELOPER)
    .flatMap((comment) => comment.inReplyTo ?? []);
}

test("fresh Fix preserves the reviewed head, merges the base, replies and names Verify", async () => {
  const { box, head } = opened();
  try {
    const ids = request(box, head);
    const base = advanceTarget(box, "upstream.txt", "upstream\n");
    const result = await box.runTaskApp("fix", FIXER, [fixes(ids)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(replies(box), ids);
    const newHead = box.git(["rev-parse", BRANCH]);
    assert.notEqual(newHead, head);
    assert.ok(box.git(["rev-list", newHead]).includes(head));
    assert.ok(box.git(["rev-list", newHead]).includes(base));
    assert.equal(box.git(["show", `${BRANCH}:counter.txt`]), "3 widgets");
    assert.ok(
      box
        .world()
        .issues.find((item) => item.number === ISSUE)
        ?.comments.some((comment) => comment.body.includes("`start:verify`")),
    );
    assert.deepEqual(box.world().tasks, []);
  } finally {
    box.cleanup();
  }
});

test("a rerun starts at the pushed head and skips threads its account answered", async () => {
  const { box, head } = opened();
  try {
    const ids = request(box, head);
    const first = await box.runTaskApp("fix", FIXER, [fixes(ids)]);
    assert.equal(first.status, 0, first.stderr);
    const pushed = box.git(["rev-parse", BRANCH]);
    applyStart(box, "start:fix");
    const rerun = await box.runTaskApp("fix", FIXER, []);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(replies(box), ids);
    assert.equal(box.launches().length, 1);
    assert.equal(box.git(["rev-parse", BRANCH]), pushed);
  } finally {
    box.cleanup();
  }
});

test("Fix resolves a conflicting base merge without rebasing", async () => {
  const { box, head } = opened();
  try {
    const ids = request(box, head);
    const base = advanceTarget(box, "counter.txt", "upstream widgets\n");
    const plan = fixes(ids);
    plan.resolve = { file: "counter.txt", content: "3 widgets\n" };
    plan.commit = null;
    const result = await box.runTaskApp("fix", FIXER, [plan]);
    assert.equal(result.status, 0, result.stderr);
    const parents = box.git(["log", "-1", "--format=%P", BRANCH]).split(" ");
    assert.deepEqual(parents, [head, base]);
    assert.deepEqual(replies(box), ids);
  } finally {
    box.cleanup();
  }
});

test("three Verify-triggered rounds are allowed and a fourth asks a person", async () => {
  const { box, head } = opened();
  try {
    request(box, head, []);
    request(box, head, []);
    const ids = request(box, head);
    const third = await box.runTaskApp("fix", FIXER, [fixes(ids)]);
    assert.equal(third.status, 0, third.stderr);
    const pushed = box.git(["rev-parse", BRANCH]);
    request(box, pushed);
    applyStart(box, "start:fix");
    const fourth = await box.runTaskApp("fix", FIXER, []);
    assert.equal(fourth.status, 0, fourth.stderr);
    assert.equal(box.git(["rev-parse", BRANCH]), pushed);
    assert.equal(box.launches().length, 1);
    assert.ok(
      box
        .world()
        .issues.find((item) => item.number === ISSUE)
        ?.comments.some((comment) =>
          comment.body.includes("person needs to step in"),
        ),
    );
  } finally {
    box.cleanup();
  }
});

test("resolved threads and nits need no session or reply", async () => {
  const { box, head } = opened();
  try {
    const [resolved] = request(box, head, [
      "Already fixed.",
      "**Nit (non-blocking)**: spelling",
    ]);
    box.change((world) => {
      const comment = world.pulls?.[0]?.reviewComments?.find(
        (item) => item.id === resolved,
      );
      if (comment !== undefined) {
        comment.resolved = true;
      }
    });
    const result = await box.runTaskApp("fix", FIXER, []);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(replies(box), []);
    assert.equal(box.launches().length, 0);
  } finally {
    box.cleanup();
  }
});

test("a review without a start label never starts Fix", async () => {
  const { box, head } = opened();
  try {
    request(box, head);
    box.change((world) => {
      const issue = world.issues.find((item) => item.number === ISSUE);
      if (issue !== undefined) {
        issue.labels = [];
      }
    });
    const result = await box.runTaskApp("fix", FIXER, []);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(box.launches().length, 0);
    assert.deepEqual(replies(box), []);
    assert.equal(box.git(["rev-parse", BRANCH]), head);
  } finally {
    box.cleanup();
  }
});

test("a missing reply fails with a retry comment and keeps the checkout", async () => {
  const { box, head } = opened();
  try {
    request(box, head);
    const result = await box.runTaskApp("fix", FIXER, [fixes([])]);
    assert.equal(result.status, 1);
    assert.deepEqual(replies(box), []);
    assert.ok(
      box
        .world()
        .issues.find((item) => item.number === ISSUE)
        ?.comments.some((comment) =>
          comment.body.includes("apply `start:fix` again"),
        ),
    );
    assert.ok(
      fs.readdirSync(path.join(box.pipeline, "work", "acme__widgets", "jobs"))
        .length > 0,
    );
  } finally {
    box.cleanup();
  }
});

test("a competing push is preserved and the losing run posts no replies", async () => {
  const { box, head } = opened();
  try {
    const ids = request(box, head);
    const plan = fixes(ids);
    plan.change = "rival-push";
    plan.changeFirst = true;
    const result = await box.runTaskApp("fix", FIXER, [plan]);
    assert.equal(result.status, 1);
    assert.deepEqual(replies(box), []);
    assert.equal(box.git(["show", `${BRANCH}:rival.txt`]), "another worker");
    assert.ok(box.git(["rev-list", BRANCH]).includes(head));
  } finally {
    box.cleanup();
  }
});
