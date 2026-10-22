// @ts-check
// The real merged verification copy reuses and releases its issue's slot.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  consumed,
  mergedView,
  prStep,
  script,
} from "../explicit-target-test-kit.mjs";
import {
  BASE,
  BRANCH,
  git,
  ISSUE,
  PR,
  world,
} from "../explicit-target-world-test-kit.mjs";

const { withCheckout } = await import("../../src/config.ts");
const { removeWorktree, setUpCheckout } = await import(
  "../../src/checkouts.ts"
);
const {
  assertCheckoutReadyForRemoval,
  checkoutEnvironment,
  releaseCheckoutSlot,
  withCheckoutSlot,
} = await import("../../src/lane-slots.ts");
const { verify } = await import("../../src/ops/verify.ts");
const SETUP_FAILED = /lane setup failed|setup is incomplete/u;
const INCOMPLETE = /setup is incomplete/u;
const DEPENDENT = /depends on Git metadata/u;
const NO_CAPACITY = /no free lane slot/u;
const NOT_CLAIMED = /claim its checkout/u;

/** @param {string} outcome */
function fixture(outcome) {
  const original = world();
  const caller = path.join(original.place, "caller");
  git(original.place, ["clone", "-q", original.origin, caller]);
  git(caller, ["checkout", "-q", BRANCH]);
  const w = { ...original, wt: caller };
  const marker = path.join(w.place, "setup-location");
  const ranTests = path.join(w.place, "tests-ran");
  const teardownMarker = path.join(w.place, "teardown-ran");
  const cfg = withCheckout(
    {
      ...w.cfg,
      laneSlots: 1,
      commands: {
        setup: `printf '%s\\n%s\\n' "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" > '${marker}'; ${outcome}`,
        test: `touch '${ranTests}'`,
        teardown: `touch '${teardownMarker}'`,
      },
    },
    { issue: ISSUE, dir: caller, branch: BRANCH },
  );
  withCheckoutSlot(cfg, ISSUE, () => true);
  git(w.seed, ["push", "-q", "origin", `${w.merged}:refs/heads/${BASE}`]);
  script(w, [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)]);
  return {
    w,
    cfg,
    marker,
    ranTests,
    teardownMarker,
    request: { number: ISSUE, codeMerged: { pr: PR, sha: w.merged } },
  };
}

test("merged verification reuses its issue slot and removes its temporary registration", () => {
  const { w, cfg, marker, ranTests, teardownMarker, request } = fixture("true");
  const result = verify(cfg, request);
  assert.equal(result.pass, true);
  assert.equal(result.headSha, w.merged);
  consumed();
  const [assigned, secondary] = fs
    .readFileSync(marker, "utf8")
    .trim()
    .split("\n");
  assert.equal(assigned, "1");
  assert.equal(fs.existsSync(String(secondary)), false);
  assert.equal(fs.existsSync(ranTests), true);
  assert.equal(fs.existsSync(teardownMarker), true);
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.head);
  assert.equal(
    checkoutEnvironment(cfg, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  assert.throws(
    () => withCheckoutSlot(cfg, ISSUE + 1, () => true),
    NO_CAPACITY,
  );
  assertCheckoutReadyForRemoval(cfg, ISSUE, fs.realpathSync(w.wt));
  fs.rmSync(w.wt, { recursive: true, force: true });
  releaseCheckoutSlot(cfg);
  assert.throws(() => checkoutEnvironment(cfg, ISSUE), NOT_CLAIMED);
  assert.equal(
    withCheckoutSlot(cfg, ISSUE + 1, () => true),
    true,
  );
});

test("failed merged setup retains recovery, usable Git and capacity until explicit successful recovery and removal", () => {
  const { w, cfg, marker, ranTests, teardownMarker, request } = fixture(
    "printf recovery > setup-local-work; exit 2",
  );
  assert.throws(() => verify(cfg, request), SETUP_FAILED);
  consumed();
  const [assigned, location] = fs
    .readFileSync(marker, "utf8")
    .trim()
    .split("\n");
  const secondary = String(location);
  assert.equal(assigned, "1");
  assert.equal(fs.existsSync(secondary), true);
  assert.equal(
    fs.readFileSync(path.join(secondary, "setup-local-work"), "utf8"),
    "recovery",
  );
  assert.equal(fs.existsSync(ranTests), false);
  assert.equal(fs.existsSync(teardownMarker), false);
  assert.equal(git(secondary, ["rev-parse", "HEAD"]), w.merged);
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.head);
  assert.throws(
    () => assertCheckoutReadyForRemoval(cfg, ISSUE, secondary),
    INCOMPLETE,
  );
  assert.throws(() => removeWorktree(cfg, ISSUE), DEPENDENT);
  assert.equal(git(secondary, ["rev-parse", "HEAD"]), w.merged);
  assert.equal(
    checkoutEnvironment(cfg, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  assert.throws(
    () => withCheckoutSlot(cfg, ISSUE + 1, () => true),
    NO_CAPACITY,
  );
  const retry = { ...cfg, commands: { ...cfg.commands, setup: "true" } };
  setUpCheckout(retry, ISSUE, secondary, "explicit-recovery.log");
  assert.doesNotThrow(() =>
    assertCheckoutReadyForRemoval(cfg, ISSUE, secondary),
  );
  git(w.wt, ["worktree", "remove", "--force", secondary]);
  fs.rmSync(path.dirname(secondary), { recursive: true, force: true });
  releaseCheckoutSlot(cfg);
  assertCheckoutReadyForRemoval(cfg, ISSUE, fs.realpathSync(w.wt));
  fs.rmSync(w.wt, { recursive: true, force: true });
  releaseCheckoutSlot(cfg);
  assert.throws(() => checkoutEnvironment(cfg, ISSUE), NOT_CLAIMED);
  assert.equal(
    withCheckoutSlot(cfg, ISSUE + 1, () => true),
    true,
  );
});

test("failed no-slot merged setup retains legacy failed-check response and temporary checkout cleanup", () => {
  const { w, cfg, marker, ranTests, teardownMarker, request } = fixture(
    "printf legacy > setup-local-work; exit 2",
  );
  const legacy = { ...cfg, laneSlots: undefined };
  const result = verify(legacy, request);
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["setup"],
  );
  consumed();
  const [assigned, secondary] = fs
    .readFileSync(marker, "utf8")
    .trimEnd()
    .split("\n");
  assert.equal(assigned, "");
  assert.equal(fs.existsSync(String(secondary)), false);
  assert.equal(fs.existsSync(ranTests), false);
  assert.equal(fs.existsSync(teardownMarker), true);
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.head);
});
