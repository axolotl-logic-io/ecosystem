// @ts-check
// Exact Land on the task-result path through the built ops (#185): Land
// needs passed Hardening, Integration and Security results for exactly R on
// T, and Completion consumes the exact Land result. Missing, stale or legacy
// evidence lands nothing, while a merge without a binding behaves exactly as
// installed. A hook on the origin records when the target is written.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { ISSUE, integrationWorld } from "./integration-task-test-kit.mjs";
import { faultNextPush } from "./sync-task-test-kit.mjs";
import {
  recordAttempt,
  recordKindsOn,
  recordResult,
  runId,
  statusOf,
} from "./task-results-test-kit.mjs";

const SHA_LENGTH = 40;
const OTHER_TARGET = "a".repeat(SHA_LENGTH);
const NO_INTEGRATION =
  /Integration for this exact revision and target is missing/u;
const NOT_DELIVERED = /Land of this binding is missing/u;
const LAND_BLOCKS = /armed or uncertain/u;
const NOT_THIS_MERGE = /not the merge's exact revision and target/u;

const READ_ONLY_PR = new Set(["view", "list", "checks"]);

/** @param {string} dir @param {number} from @returns {string[][]} PR writes, approvals and merges GitHub saw */
function prWrites(dir, from) {
  return ghCalls(dir)
    .slice(from)
    .filter(
      (args) =>
        (args[0] === "pr" && !READ_ONLY_PR.has(String(args[1]))) ||
        args.some((arg) => arg.includes("/reviews") || arg.includes("/merges")),
    );
}

test("Land refuses missing, stale or legacy Integration evidence; without a binding it lands as installed", () => {
  const world = integrationWorld();
  const ready = world.readyToLand();
  world.passed("Hardening");
  world.passed("Security");
  const landRun = { id: runId(), previous: null };
  const from = ghCalls(world.flow.ghDir).length;
  const missing = world.land(ready, { binding: world.bound("Land"), landRun });
  assert.partialDeepStrictEqual(missing, {
    merged: false,
    reason: "task-results",
  });
  assert.match(String(missing.detail), NO_INTEGRATION);
  // An Integration pass on another target is stale for this Land.
  const stale = {
    ...world.bound("Integration"),
    target: { branch: "integration", commit: OTHER_TARGET },
  };
  const staleRun = runId();
  recordAttempt(world.flow, ISSUE, stale, { id: staleRun, previous: null });
  recordResult(world.flow, ISSUE, stale, {
    run: staleRun,
    verdict: "passed",
    summary: "R on another target",
  });
  const staleLand = world.land(ready, {
    binding: world.bound("Land"),
    landRun,
  });
  assert.match(String(staleLand.detail), NO_INTEGRATION);
  // A Land binding must name this merge's exact revision and target.
  const elsewhere = world.land(ready, {
    binding: {
      ...world.bound("Land"),
      target: { branch: "integration", commit: OTHER_TARGET },
    },
    landRun,
  });
  assert.match(String(elsewhere.detail), NOT_THIS_MERGE);
  // Saved state already holds verifiedSha = R and hardening of R on T, as the
  // legacy writable Integration left them; neither is a result.
  const legacy = world.land(ready, { binding: world.bound("Land"), landRun });
  assert.match(String(legacy.detail), NO_INTEGRATION);
  assert.equal(world.remoteTarget(), world.start, "the target never moved");
  assert.deepEqual(
    prWrites(world.flow.ghDir, from),
    [],
    "no approval or merge",
  );
  assert.equal(
    statusOf(world.flow, ISSUE, world.bound("Land")).status,
    "missing",
    "no Land attempt",
  );
  // The installed merge path is unchanged: no binding, no task results needed.
  const installed = world.land(ready, {});
  assert.equal(installed.merged, true, JSON.stringify(installed));
  assert.equal(world.remoteTarget(), world.revision);
});

test("checks and Security finish before the exact Land writes the target, and Completion runs no suite", () => {
  const world = integrationWorld();
  const seq = path.join(world.flow.tmp, "sequence.log");
  const worldFile = path.join(world.flow.ghDir, "world.json");
  fs.writeFileSync(
    path.join(world.flow.origin, "hooks", "post-receive"),
    `#!/usr/bin/env bash\nwhile read -r old new ref; do\n  if [ "$ref" = "refs/heads/integration" ]; then\n    echo "target-write $(grep -o 'agent-pipeline:task-result' ${JSON.stringify(worldFile)} | wc -l)" >> ${JSON.stringify(seq)}\n  fi\ndone\n`,
    { mode: 0o755 },
  );
  world.setCheck(`echo check >> ${seq}`);
  const ready = world.readyToLand();
  world.passed("Hardening");
  assert.partialDeepStrictEqual(world.integrate(), {
    route: "security",
    verdict: "passed",
  });
  world.passed("Security");
  const landed = world.land(ready, {
    binding: world.bound("Land"),
    landRun: { id: runId(), previous: null },
  });
  assert.equal(landed.merged, true, JSON.stringify(landed));
  assert.equal(
    world.remoteTarget(),
    world.revision,
    "an exact fast-forward to R",
  );
  const delivery = { pr: ready.pr, sha: String(landed.mergeCommit) };
  assert.partialDeepStrictEqual(world.confirm(delivery, world.bound("Land")), {
    confirmed: true,
    headSha: world.revision,
  });
  // Hardening, Integration and Security each recorded an attempt and a
  // result, and Land its attempt, before the one write of the target.
  assert.deepEqual(fs.readFileSync(seq, "utf8").trim().split("\n"), [
    "check",
    "target-write 7",
  ]);
  assert.deepEqual(recordKindsOn(world.flow.ghDir, ISSUE).slice(-2), [
    "attempt",
    "result",
  ]);
  assert.partialDeepStrictEqual(
    statusOf(world.flow, ISSUE, world.bound("Land")),
    {
      status: "passed",
      result: { receipt: { produced: { code: delivery.sha } } },
    },
  );
  // Completion consumes this exact delivery and nothing else.
  const otherLand = {
    ...world.bound("Land"),
    target: { branch: "integration", commit: OTHER_TARGET },
  };
  const refused = world.confirm(delivery, otherLand);
  assert.equal(refused.confirmed, false);
  assert.match(String(refused.reason), NOT_DELIVERED);
});

test("an uncertain Land stays unsettled and holds Sync and Integration; a replay never repeats the write", () => {
  const world = integrationWorld();
  // Read-only confirmation gives up quickly instead of waiting minutes.
  world.configure({
    mergeConfirmation: { deadlineSeconds: 1, backoffSeconds: [1] },
  });
  const ready = world.readyToLand();
  world.passed("Hardening");
  world.passed("Integration");
  world.passed("Security");
  faultNextPush(world.flow, "refuse");
  const binding = world.bound("Land");
  const lost = world.land(ready, {
    binding,
    landRun: { id: runId(), previous: null },
  });
  assert.equal(lost.merged, false, JSON.stringify(lost));
  assert.equal(world.remoteTarget(), world.start);
  assert.equal(statusOf(world.flow, ISSUE, binding).status, "unknown");
  const sync = world.sync("sync-task", {
    binding: {
      ...binding,
      task: "Sync",
      target: { branch: "integration", commit: world.start },
    },
    run: { id: runId(), previous: null },
  });
  assert.match(String(sync.error), LAND_BLOCKS);
  assert.match(String(world.integrate().error), LAND_BLOCKS);
  // A replay reconciles read-only: it can't establish the delivery, so the
  // Land stays unsettled and the target stays where it was.
  const from = ghCalls(world.flow.ghDir).length;
  const replay = world.land(ready, {
    binding,
    landRun: { id: runId(), previous: null },
  });
  assert.equal(replay.merged, false);
  assert.equal(world.remoteTarget(), world.start);
  assert.deepEqual(prWrites(world.flow.ghDir, from), []);
  assert.equal(statusOf(world.flow, ISSUE, binding).status, "unknown");
});
