// @ts-check
// An interrupted or uncertain Sync through the built ops (#184): the run's
// attempt stays unsettled, no retry repeats its push or rebase, and
// sync-task-reconcile settles only what a read of the branch and the
// checkout establishes. Real git origin, stateful fake GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { targetPushes } from "./fake-pipeline-flow-gh-native.mjs";
import {
  faultNextPush,
  gitIn,
  inRebase,
  originContains,
  recoveryOf,
  syncWorld,
} from "./sync-task-test-kit.mjs";
import { recordAttempt, runId, statusOf } from "./task-results-test-kit.mjs";

const ISSUE = 7;
const FEATURE = { file: "feature.txt", bytes: "the issue's feature\n" };
const UNKNOWN = /the binding is unknown/u;
const HUNG_UP = /hung up unexpectedly/u;

/** @param {ReturnType<typeof syncWorld>} world @returns {number} pushes the branch has received */
function branchPushes(world) {
  return targetPushes(world.flow.origin, world.branch).length;
}

/** @param {ReturnType<typeof syncWorld>} world */
function movedTarget(world) {
  const target = world.advanceTarget("base.txt", "the target moved\n");
  return { target, bound: world.binding(target), run: runId() };
}

test("a push whose reply is lost reconciles as passed by reading, and is never repeated", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { target, bound, run } = movedTarget(world);
  const pushes = branchPushes(world);
  faultNextPush(world.flow, "lose-reply");
  const lost = world.sync("sync-task", {
    binding: bound,
    run: { id: run, previous: null },
  });
  assert.match(String(lost.error), HUNG_UP);
  assert.equal(branchPushes(world), pushes + 1, "the push did land");
  assert.partialDeepStrictEqual(statusOf(world.flow, ISSUE, bound), {
    status: "unknown",
    run,
  });
  const retry = recordAttempt(world.flow, ISSUE, bound, {
    id: runId(),
    previous: run,
  });
  assert.match(String(retry.error), UNKNOWN);
  const again = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: run },
  });
  assert.equal(again.ok, false);

  const settled = world.sync("sync-task-reconcile", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(settled.settled, "passed", JSON.stringify(settled));
  assert.equal(world.remoteBranch(), settled.produced);
  assert.ok(
    originContains(world.flow.origin, target, String(settled.produced)),
  );
  assert.equal(branchPushes(world), pushes + 1, "reconciliation only read");
  assert.equal(statusOf(world.flow, ISSUE, bound).status, "passed");
});

test("a push that never landed reconciles as failed with the rebased work kept, then a new run may try", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { bound, run } = movedTarget(world);
  const pushes = branchPushes(world);
  faultNextPush(world.flow, "refuse");
  const refused = world.sync("sync-task", {
    binding: bound,
    run: { id: run, previous: null },
  });
  assert.equal(refused.ok, false);
  const rebased = gitIn(world.wt, ["rev-parse", "HEAD"]);
  assert.notEqual(
    rebased,
    world.revision,
    "the rebased head stays in the checkout",
  );
  assert.equal(world.remoteBranch(), world.revision);
  const settled = world.sync("sync-task-reconcile", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(settled.settled, "failed", JSON.stringify(settled));
  assert.ok(recoveryOf(world.flow, ISSUE).includes("commits.bundle"));
  const bundle = fs
    .readdirSync(
      path.join(world.flow.root, "runs", "o__r", `issue-${ISSUE}`, "recovery"),
    )
    .map((dir) =>
      path.join(
        world.flow.root,
        "runs",
        "o__r",
        `issue-${ISSUE}`,
        "recovery",
        dir,
        "commits.bundle",
      ),
    )
    .find((file) => fs.existsSync(file));
  assert.ok(
    gitIn(world.wt, ["bundle", "list-heads", String(bundle)]).includes(rebased),
  );
  assert.equal(
    branchPushes(world),
    pushes,
    "nothing was pushed by reconciliation",
  );
  const next = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: run },
  });
  assert.equal(next.verdict, "passed", JSON.stringify(next));
});

test("an interrupted resolver leaves the stopped rebase retained, and reconciliation holds it", () => {
  const world = syncWorld(ISSUE, {
    file: "greet.txt",
    bytes: "hello from the issue\n",
  });
  const target = world.advanceTarget("greet.txt", "hello from the target\n");
  const bound = world.binding(target);
  const run = runId();
  assert.equal(
    world.sync("sync-task", {
      binding: bound,
      run: { id: run, previous: null },
    }).conflict,
    true,
  );
  // The resolver's session dies with half its work staged.
  fs.writeFileSync(path.join(world.wt, "greet.txt"), "hello from bo");
  const pushes = branchPushes(world);
  const held = world.sync("sync-task-reconcile", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(held.settled, false);
  assert.ok(inRebase(world.wt));
  assert.equal(
    fs.readFileSync(path.join(world.wt, "greet.txt"), "utf8"),
    "hello from bo",
  );
  assert.equal(statusOf(world.flow, ISSUE, bound).status, "unknown");
  assert.equal(branchPushes(world), pushes);
});

test("a run that ended before any effect settles as failed, and a branch nobody accounts for holds", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { bound, run } = movedTarget(world);
  recordAttempt(world.flow, ISSUE, bound, { id: run, previous: null });
  const ended = world.sync("sync-task-reconcile", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(ended.settled, "failed");
  const second = runId();
  recordAttempt(world.flow, ISSUE, bound, { id: second, previous: run });
  // Someone else moves the branch while the run is unsettled.
  const other = path.join(world.flow.tmp, "other-writer");
  gitIn(world.flow.tmp, [
    "clone",
    "-q",
    "-b",
    world.branch,
    world.flow.origin,
    other,
  ]);
  fs.writeFileSync(path.join(other, "other.txt"), "not this run's\n");
  gitIn(other, ["add", "other.txt"]);
  gitIn(other, ["commit", "-qm", "another writer"]);
  gitIn(other, ["push", "-q", "origin", `HEAD:refs/heads/${world.branch}`]);
  const unexplained = world.sync("sync-task-reconcile", {
    binding: bound,
    run: { id: second },
  });
  assert.equal(unexplained.settled, false);
  assert.equal(statusOf(world.flow, ISSUE, bound).status, "unknown");
});
