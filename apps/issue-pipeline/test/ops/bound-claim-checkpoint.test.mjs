// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { worktree } from "../ops-cli-test-kit.mjs";
import { boundFixture } from "./bound-claim-test-kit.mjs";

const { stateBody } = await import("../../src/saved-state.ts");
const { trustedInputsHash, writeIssueContext } = await import(
  "../../src/issue-context.ts"
);
const ISSUE = 540;
const AUTHOR = 541;
const WAITING = 542;
const CHANGED = /claim eligibility changed/u;

// Both versions were saved through the real authenticated seam. A stale read
// before ownership must not replace a later-visible predecessor checkpoint.
test("bound resume retains predecessor work first visible at owner confirmation", () => {
  const f = boundFixture(ISSUE);
  const older = f.claim();
  const latest = f.save({
    ...older,
    stage: "stopped",
    stoppedStage: "review",
    stopCode: "conflict",
    asked: { inputs: "answered-inputs" },
    requirementsInputs: "reviewed-inputs",
    counts: { syncs: 2, conflictFixes: 1 },
    log: ["2026-10-21T00:00:00Z retained review progress"],
  });
  f.guard().release();
  f.update((transport) => {
    const state = transport.comments.find((item) =>
      item.body.includes("agent-pipeline:state"),
    );
    if (state === undefined) {
      throw new Error("missing fixture state");
    }
    state.body = stateBody(f.issue, older);
    transport.stateAfterConfirm = stateBody(f.issue, latest);
  });
  const next = f.next("different");
  const got = f.claimBound(next);
  assert.ok("state" in got);
  assert.deepEqual(got.state, {
    ...latest,
    stage: "review",
    stoppedStage: null,
    stopCode: null,
    counts: { syncs: 0, conflictFixes: 0 },
    review: { ...latest.review, round: 0 },
    execution: got.state.execution,
    lease: { lane: "different", sweepId: "s1", at: got.state.lease?.at },
  });
  assert.notDeepEqual(got.state.execution, latest.execution);
  assert.deepEqual(f.read(next), got.state);
});

test("fresh bound Author initializes Author without an invented return checkpoint", () => {
  const f = boundFixture(AUTHOR);
  const got = f.claimBound(f.cfg, "author");
  assert.ok("state" in got);
  assert.equal(got.state.stage, "author");
  assert.equal(got.state.authorUsed, true);
  assert.equal(got.state.resumeStage, null);
  assert.deepEqual(got.state.log, []);
  assert.deepEqual(f.read(), got.state);
});

test("a newly visible unanswered checkpoint refuses progress after acquisition", () => {
  const f = boundFixture(WAITING);
  const older = f.claim();
  const context = writeIssueContext(f.cfg, f.issue);
  const inputs = trustedInputsHash(f.cfg, context.issue, context.comments);
  const latest = f.save({ ...older, asked: { inputs } });
  f.guard().release();
  f.update((transport) => {
    const state = transport.comments.find((item) =>
      item.body.includes("agent-pipeline:state"),
    );
    if (state === undefined) {
      throw new Error("missing fixture state");
    }
    state.body = stateBody(f.issue, older);
    transport.stateAfterConfirm = stateBody(f.issue, latest);
  });
  const before = f.writes().length;
  const next = f.next();
  assert.throws(() => f.claimBound(next), CHANGED);
  assert.deepEqual(f.read(next)?.asked, latest.asked);
  assert.equal(fs.existsSync(worktree(f.issue)), false);
  assert.equal(
    f
      .writes()
      .slice(before)
      .some((args) => args.some((arg) => arg.includes("/labels"))),
    false,
  );
});
