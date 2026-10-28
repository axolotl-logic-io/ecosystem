// Recovery of an uncertain Land through the supported buddy entrypoint, on
// a disposable machine whose trusted repository configuration grants Land.
// The Land merges its approved PR, and GitHub closes the issue for the PR's
// closing reference, but GitHub refuses the post of its passed result, so
// its attempt stays uncertain and keeps the target's integration turn. The
// next poll settles that original attempt read-only from the PR's merged
// state and the issue's state, and gives back its turn: it never merges or
// closes again. The built buddy.mjs runs the real tasks, ops, ledger and
// Git; only gh (fake-gh.ts) and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LANDING, REPO } from "../../support/signals/signal-test-kit.ts";
import {
  callsOf,
  GATEKEEPER,
  implemented,
  landsOf,
  PR,
  retainOnFailure,
  verified,
} from "./buddy-flow-land-test-kit.ts";
import { applyStart, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

// The uncertain Land and its settlement each take one poll; the third
// stops the run.
const GATEKEEPER_POLLS = 3;
// Only the Land's own passed result carries merged evidence.
const MERGED_RESULT = '"outcome":"merged"';
const TURN = `["${REPO}","main","integration"]`;

test("an uncertain Land settles its original attempt read-only, without a second merge or close", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const target = box.git(["rev-parse", "main"]);
    const head = await implemented(box, signal);
    verified(box, head, "passed");
    box.change((reported) => {
      reported.checks = { [head]: [{ name: "ci", bucket: "pass" }] };
      reported.failPostOnceContaining = MERGED_RESULT;
    });

    applyStart(box, "start:land");
    const gatekeeper = await box.runBuddy(
      [],
      GATEKEEPER_POLLS,
      GATEKEEPER,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    assert.equal(gatekeeper.ended.kind, "stopped");
    const lands = landsOf(gatekeeper);
    const original = lands.find((action) => action.mode === "act");
    const reconciler = lands.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && reconciler !== undefined);
    assert.equal(lands.length, 2);
    // The Land merged, then lost its result's post: its own land-task is
    // uncertain and it settled nothing.
    assert.deepEqual(
      [
        original.verdict,
        original.operations.map((item) => [item.op, item.outcome]),
        original.ownership.state,
      ],
      [
        "unknown",
        [
          ["task-attempt", "ok"],
          ["land-task", "failed"],
          ["task-result", "ok"],
        ],
        "released",
      ],
    );
    assert.ok(original.reason?.startsWith("land-task is uncertain: "));
    const merge = box.git(["rev-parse", "main"]);
    assert.deepEqual(
      box.git(["rev-list", "--parents", "-n", "1", merge]).split(" "),
      [merge, target, head],
    );
    // Its recovery settled that original attempt from reads alone.
    const settlement = `reconciled by ${reconciler.id}: merged PR #${PR} at ${head} as ${merge} and closed #${ISSUE}`;
    assert.deepEqual(
      [
        reconciler.previous,
        reconciler.verdict,
        reconciler.reason,
        reconciler.operations.map((item) => [item.op, item.outcome]),
        reconciler.ownership.state,
      ],
      [
        original.id,
        "passed",
        settlement,
        [["land-reconcile", "ok"]],
        "released",
      ],
    );
    assert.deepEqual(reconciler.binding, original.binding);

    // The ledger: the original run's uncertain result, then its passed
    // settlement by the reconciler, with the merge's evidence.
    const world = box.world();
    const results = marked(world, "task-result").filter(
      (record) =>
        record.kind === "result" &&
        JSON.stringify(record.run) ===
          JSON.stringify({ id: original.id, previous: null }),
    );
    assert.deepEqual(
      results.map((record) => record.verdict),
      ["unknown", "passed"],
    );
    assert.deepEqual(results.at(-1)?.receipt, {
      summary: settlement,
      produced: { code: merge },
      evidence: {
        outcome: "merged",
        pr: PR,
        head,
        mergeCommit: merge,
        issueClosed: true,
      },
    });
    assert.equal(world.failPostOnceContaining, undefined);
    // One merge, and the issue closed once, by GitHub for the merge.
    assert.equal(callsOf(box, ["pr", "merge"]).length, 1);
    assert.deepEqual(callsOf(box, ["issue", "close"]), []);
    const issue = world.issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.closed, { by: LANDING, reason: "completed" });
    assert.equal(
      box.git(["reflog", "show", "--format=%H", "refs/heads/main"]),
      `${merge}\n${target}`,
    );

    // The reconciler gave back the turn the original Land took, once.
    const turn = marked(world, "coordination").filter(
      (item) => item.scope === TURN,
    );
    assert.deepEqual(
      turn.map((item) => item.kind),
      ["request", "confirm", "release"],
    );
    const released = turn.at(-1);
    assert.ok(released !== undefined);
    const { evidence: retirement } = released;
    assert.deepEqual(retirement, { retiredBy: reconciler.id });
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land recovery");
  }
});
