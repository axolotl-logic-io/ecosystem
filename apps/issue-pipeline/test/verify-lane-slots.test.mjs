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
} from "./explicit-target-test-kit.mjs";
import {
  BASE,
  git,
  ISSUE,
  PR,
  world,
} from "./explicit-target-world-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { checkoutEnvironment, releaseCheckoutSlot, withCheckoutSlot } =
  await import("../src/lane-slots.ts");
const { verify } = await import("../src/ops/verify.ts");
const SETUP_FAILED = /lane setup failed/u;
const NO_CAPACITY = /no free lane slot/u;
const NOT_CLAIMED = /claim its checkout/u;

/** @param {string} outcome */
function fixture(outcome) {
  const w = world();
  const marker = path.join(w.place, "setup-location");
  const ranTests = path.join(w.place, "tests-ran");
  const cfg = {
    ...w.cfg,
    laneSlots: 1,
    commands: {
      setup: `printf '%s\\n%s\\n' "$ISSUE_PIPELINE_LANE_SLOT" "$PWD" > '${marker}'; ${outcome}`,
      test: `touch '${ranTests}'`,
    },
  };
  withCheckoutSlot(cfg, ISSUE, () => true);
  git(w.seed, ["push", "-q", "origin", `${w.merged}:refs/heads/${BASE}`]);
  script(w, [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)]);
  return {
    w,
    cfg,
    marker,
    ranTests,
    request: { number: ISSUE, codeMerged: { pr: PR, sha: w.merged } },
  };
}

test("merged verification reuses its issue slot and removes its temporary registration", () => {
  const { w, cfg, marker, ranTests, request } = fixture("true");
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
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.head);
  assert.equal(
    checkoutEnvironment(cfg, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  assert.throws(
    () => withCheckoutSlot(cfg, ISSUE + 1, () => true),
    NO_CAPACITY,
  );
  git(paths.clone(cfg), ["worktree", "remove", "--force", w.wt]);
  releaseCheckoutSlot(cfg);
  assert.throws(() => checkoutEnvironment(cfg, ISSUE), NOT_CLAIMED);
  assert.equal(
    withCheckoutSlot(cfg, ISSUE + 1, () => true),
    true,
  );
});

test("failed merged setup starts no tests and removes its temporary registration without moving the primary", () => {
  const { w, cfg, marker, ranTests, request } = fixture("exit 2");
  assert.throws(() => verify(cfg, request), SETUP_FAILED);
  consumed();
  const [assigned, secondary] = fs
    .readFileSync(marker, "utf8")
    .trim()
    .split("\n");
  assert.equal(assigned, "1");
  assert.equal(fs.existsSync(String(secondary)), false);
  assert.equal(fs.existsSync(ranTests), false);
  assert.equal(git(w.wt, ["rev-parse", "HEAD"]), w.head);
  assert.equal(
    checkoutEnvironment(cfg, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  git(paths.clone(cfg), ["worktree", "remove", "--force", w.wt]);
  releaseCheckoutSlot(cfg);
  assert.throws(() => checkoutEnvironment(cfg, ISSUE), NOT_CLAIMED);
  assert.equal(
    withCheckoutSlot(cfg, ISSUE + 1, () => true),
    true,
  );
});
