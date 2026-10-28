// Land through the supported buddy entrypoint, on a disposable machine
// whose trusted repository configuration grants it: a Developer implements
// the started issue into PR #8, its head is approved, and a Gatekeeper
// responsible for Land merges the PR with a merge commit pinned to that
// head and closes the issue once a person applies `start:land`, or, when the
// PR conflicts with its base or doesn't contain it, marks the PR a draft and
// refuses for Fix. A person's
// standing request for changes holds it, and a person's approval waits for
// Verify's pass of the head, so its Security review always runs before the
// merge. A close that fails after the merge is made once by the Land's
// recovery. The built buddy.mjs runs the real
// tasks, ops, ledger and Git; only gh (fake-gh.ts) and pi (fake-pi.ts) are
// fakes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import {
  callsOf,
  GATEKEEPER,
  implemented,
  landsOf,
  PR,
  retainOnFailure,
  review,
  verified,
} from "./buddy-flow-land-test-kit.ts";
import type { Machine } from "./buddy-flow-test-kit.ts";
import {
  applyStart,
  HUMAN,
  ISSUE,
  machine,
  marked,
} from "./buddy-flow-test-kit.ts";

// The Land acts on the first poll; the second stops the run.
const LAND_POLLS = 2;
// The uncertain Land, its recovery, then stop.
const RECOVERY_POLLS = 3;
// The start's acceptance, its Land, then stop.
const REVIEW_POLLS = 3;

// Required CI passes on `head`.
function greenCi(box: Machine, head: string): void {
  box.change((world) => {
    world.checks = { [head]: [{ name: "ci", bucket: "pass" }] };
  });
}

// Moves the target with one commit of `file`, as another merge would.
function moveTarget(box: Machine, file: string, content: string): string {
  fs.writeFileSync(path.join(box.work, file), content);
  for (const args of [
    ["add", file],
    ["commit", "--quiet", "-m", `Change ${file}`],
    ["push", "--quiet", "origin", "main"],
  ]) {
    const done = spawnSync("git", ["-C", box.work, ...args], {
      encoding: "utf8",
    });
    if (done.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
    }
  }
  return box.git(["rev-parse", "main"]);
}

function landResults(box: Machine): ReturnType<typeof marked> {
  return marked(box.world(), "task-result").filter(
    (row) =>
      row.kind === "result" && JSON.stringify(row).includes('"task":"land"'),
  );
}

test("Land merges an approved PR at its checked head and closes the issue", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "main"]);
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    greenCi(box, head);
    // No closing reference: Land closes the issue itself.
    box.change((reported) => {
      const pull = reported.pulls?.find((item) => item.number === PR);
      if (pull !== undefined) {
        pull.body = "Counts the widgets.";
      }
    });

    applyStart(box, "start:land");
    const gatekeeper = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const [land, ...more] = landsOf(gatekeeper);
    assert.ok(land !== undefined);
    assert.deepEqual(more, []);
    const merge = box.git(["rev-parse", "main"]);
    assert.deepEqual(
      [land.verdict, land.operations.map((item) => [item.op, item.outcome])],
      [
        "passed",
        [
          ["task-attempt", "ok"],
          ["land-task", "ok"],
          ["task-result", "ok"],
        ],
      ],
    );
    // One merge commit of the head over the old target, made by GitHub
    // for the one pinned merge call.
    assert.deepEqual(
      box.git(["rev-list", "--parents", "-n", "1", merge]).split(" "),
      [merge, target, head],
    );
    assert.deepEqual(callsOf(box, ["pr", "merge"]), [
      [
        "pr",
        "merge",
        String(PR),
        "-R",
        "acme/widgets",
        "--merge",
        "--match-head-commit",
        head,
      ],
    ]);
    const world = box.world();
    assert.equal(
      world.pulls?.find((item) => item.number === PR)?.mergeCommit,
      merge,
    );
    const issue = world.issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.closed, { by: LANDING, reason: "completed" });
    assert.equal(callsOf(box, ["issue", "close"]).length, 1);
    // One result covers the merge and the close.
    const [result, ...others] = landResults(box);
    assert.deepEqual(others, []);
    assert.deepEqual(result?.receipt, {
      summary: `merged PR #${PR} at ${head} as ${merge} and closed #${ISSUE}`,
      produced: { code: merge },
      evidence: {
        outcome: "merged",
        pr: PR,
        head,
        mergeCommit: merge,
        issueClosed: true,
      },
    });
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land merge");
  }
});

test("an approved PR that conflicts with its base becomes a draft for Fix", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    greenCi(box, head);
    const base = moveTarget(box, "counter.txt", "4 widgets\n");

    applyStart(box, "start:land");
    const gatekeeper = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const [land, ...more] = landsOf(gatekeeper);
    assert.ok(land !== undefined);
    assert.deepEqual(more, []);
    assert.equal(land.verdict, "refused");
    const reason = `PR #${PR} at ${head} conflicts with main at ${base}`;
    assert.deepEqual(landResults(box).at(-1)?.receipt, {
      summary: `${reason}; marked PR #${PR} a draft for Fix`,
      evidence: {
        outcome: "conflict",
        pr: PR,
        head,
        base: { branch: "main", commit: base },
        reason,
      },
    });
    // Nothing merged or closed; the PR is a draft at the same head.
    assert.deepEqual(callsOf(box, ["pr", "merge"]), []);
    assert.equal(box.git(["rev-parse", "main"]), base);
    const world = box.world();
    const pull = world.pulls?.find((item) => item.number === PR);
    assert.deepEqual([pull?.isDraft, pull?.state], [true, "OPEN"]);
    assert.equal(
      world.issues.find((item) => item.number === ISSUE)?.closed,
      undefined,
    );
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land conflict");
  }
});

test("an approved head that doesn't contain a moved base goes to Fix even when GitHub could merge it", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    greenCi(box, head);
    const base = moveTarget(box, "README.md", "widgets and gadgets\n");

    applyStart(box, "start:land");
    const gatekeeper = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    assert.deepEqual(
      landsOf(gatekeeper).map((action) => action.verdict),
      ["refused"],
    );
    assert.deepEqual(landResults(box).at(-1)?.receipt, {
      summary: `PR #${PR}'s head ${head} does not contain main at ${base}; marked PR #${PR} a draft for Fix`,
      evidence: {
        outcome: "conflict",
        pr: PR,
        head,
        base: { branch: "main", commit: base },
        reason: `PR #${PR}'s head ${head} does not contain main at ${base}`,
      },
    });
    assert.deepEqual(callsOf(box, ["pr", "merge"]), []);
    assert.equal(box.git(["rev-parse", "main"]), base);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land stale head");
  }
});

test("a person's standing request for changes holds an approved Land until they approve", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "main"]);
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    greenCi(box, head);
    box.change((world) => {
      review(world, HUMAN, "CHANGES_REQUESTED", head);
    });

    applyStart(box, "start:land");
    const held = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(held.status, 0, held.stderr);
    // The admission check refused before any record: no attempt, no merge.
    assert.deepEqual(landsOf(held), []);
    assert.equal(
      held.run.loops.find((loop) => loop.task === "land")?.reason,
      `no attempt began: @${HUMAN} requested changes on ${head}`,
    );
    assert.deepEqual(landResults(box), []);
    assert.equal(box.git(["rev-parse", "main"]), target);

    // Their later approval of the same head replaces their request.
    box.change((world) => {
      review(world, HUMAN, "APPROVED", head);
    });
    const landed = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(landed.status, 0, landed.stderr);
    assert.deepEqual(
      landsOf(landed).map((action) => action.verdict),
      ["passed"],
    );
    assert.equal(box.git(["rev-parse", "main^2"]), head);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land review hold");
  }
});

test("a qualified person's approval waits for Verify's Security review of the head before it lands", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "main"]);
    const head = await implemented(box, signal);
    greenCi(box, head);
    box.change((world) => {
      review(world, HUMAN, "APPROVED", head);
    });

    // No Verify has passed the head, so the approval lands nothing.
    applyStart(box, "start:land");
    const held = await box.runBuddy([], REVIEW_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(held.status, 0, held.stderr);
    assert.deepEqual(landsOf(held), []);
    assert.equal(
      held.run.loops.find((loop) => loop.task === "land")?.reason,
      `Verify, and so its Security review, has not passed ${head}`,
    );
    assert.deepEqual(callsOf(box, ["pr", "merge"]), []);
    assert.equal(box.git(["rev-parse", "main"]), target);

    // The pending start lands once Verify passes the same head.
    verified(box, head, "passed");
    const landed = await box.runBuddy([], LAND_POLLS, GATEKEEPER, signal);
    signal.throwIfAborted();
    assert.equal(landed.status, 0, landed.stderr);
    assert.deepEqual(
      landsOf(landed).map((action) => action.verdict),
      ["passed"],
    );
    assert.deepEqual(
      box.git(["rev-list", "--parents", "-n", "1", "main"]).split(" ").slice(1),
      [target, head],
    );
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land on a person's approval");
  }
});

test("a Land whose issue close fails closes the issue once when it recovers", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    greenCi(box, head);
    // No closing reference, and GitHub fails Land's own close once.
    box.change((reported) => {
      const pull = reported.pulls?.find((item) => item.number === PR);
      if (pull !== undefined) {
        pull.body = "Counts the widgets.";
      }
      reported.failIssueCloses = 1;
    });

    applyStart(box, "start:land");
    const gatekeeper = await box.runBuddy(
      [],
      RECOVERY_POLLS,
      GATEKEEPER,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const lands = landsOf(gatekeeper);
    const original = lands.find((action) => action.mode === "act");
    const reconciler = lands.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && reconciler !== undefined);
    assert.equal(lands.length, 2);
    assert.equal(original.verdict, "unknown");
    assert.equal(reconciler.verdict, "passed", reconciler.reason ?? "");
    assert.equal(reconciler.previous, original.id);
    const merge = box.git(["rev-parse", "main"]);
    assert.equal(
      reconciler.reason,
      `reconciled by ${reconciler.id}: merged PR #${PR} at ${head} as ${merge} and closed #${ISSUE}`,
    );
    // One merge; the failed close, then the recovery's one close.
    assert.equal(callsOf(box, ["pr", "merge"]).length, 1);
    assert.equal(callsOf(box, ["issue", "close"]).length, 2);
    const issue = box.world().issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.closed, { by: LANDING, reason: "completed" });
    assert.deepEqual(
      landResults(box).map((result) => result.verdict),
      ["unknown", "passed"],
    );
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land close recovery");
  }
});
