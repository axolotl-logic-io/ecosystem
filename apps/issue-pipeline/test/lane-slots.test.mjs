// @ts-check
// Ownership follows surviving checkouts, never process age or saved patches.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { config, occupy, slot } from "./lane-slots-test-kit.mjs";

const { paths, withCheckout } = await import("../src/config.ts");
const { setUpCheckout, removeWorktree } = await import("../src/checkouts.ts");
const {
  assertCheckoutReadyForRemoval,
  checkoutEnvironment,
  releaseCheckoutSlot,
  withCheckoutSlot,
} = await import("../src/lane-slots.ts");
const NO_SLOT = /no free lane slot.*retry/u;
const THIRD_ISSUE = 3;
const FOURTH_ISSUE = 4;
const MAX_SLOT = 399;
const OUTSIDE_POOL = 400;
const FRACTIONAL_POOL = 1.5;
const POOL_CONFIG_ERROR = /laneSlots/u;
const PRUNE_CONFIG_ERROR = /prune/u;
const SETUP_RETRY_REQUIRED = /lane setup failed.*explicitly retry/u;
const SETUP_INCOMPLETE = /setup is incomplete/u;
const CLAIM_REQUIRED = /claim its checkout/u;
const OWNERSHIP_RECONCILIATION = /reconcile before retrying/u;
const OWNERSHIP_MISSING = /ownership is missing/u;
test("lane pool validation accepts only integers from 1 through 399 and validates prune", () => {
  for (const laneSlots of [1, MAX_SLOT]) {
    assert.equal(config({ laneSlots }).laneSlots, laneSlots);
  }
  for (const laneSlots of [0, -1, OUTSIDE_POOL, FRACTIONAL_POOL, "2", null]) {
    assert.throws(() => config({ laneSlots }), POOL_CONFIG_ERROR);
  }
  assert.throws(
    () => config({ commands: { test: "true", prune: 5 } }),
    PRUNE_CONFIG_ERROR,
  );
  assert.equal(
    config({ commands: { test: "true", prune: "true" } }).commands.prune,
    "true",
  );
});

test("an omitted pool leaves legacy setup and checkout behavior unchanged", () => {
  const marker = path.join(isolatedRoot, "legacy-setup");
  const cfg = config({
    laneSlots: undefined,
    commands: { test: "true", setup: `printf legacy > '${marker}'` },
  });
  assert.equal(cfg.laneSlots, undefined);
  assert.equal(occupy(cfg, 1), undefined);
  assert.equal(checkoutEnvironment(cfg, 1).size, 0);
  setUpCheckout(cfg, 1, paths.worktree(cfg, 1), "setup.log");
  assert.equal(fs.readFileSync(marker, "utf8"), "legacy");
});

test("persistent issue checkouts keep distinct deterministic slots across claims and reclaims", () => {
  const cfg = config();
  assert.equal(occupy(cfg, 1), "1");
  assert.equal(occupy(cfg, 2), "2");
  assert.equal(occupy(cfg, 1), "1");
  let called = false;
  assert.throws(
    () =>
      withCheckoutSlot(cfg, THIRD_ISSUE, () => {
        called = true;
        return true;
      }),
    NO_SLOT,
  );
  assert.equal(called, false);
  assert.equal(fs.existsSync(paths.worktree(cfg, THIRD_ISSUE)), false);
  fs.rmSync(paths.worktree(cfg, 1), { recursive: true });
  // A stale owner is reclaimed on the next claim, without a cleanup sweep.
  assert.equal(occupy(cfg, THIRD_ISSUE), "1");
  assert.equal(slot(cfg, 2), "2");
});

test("lost claims cancel reservations without freeing an earlier surviving owner", () => {
  const cfg = config({ laneSlots: 1 });
  assert.equal(
    withCheckoutSlot(cfg, 1, () => null),
    null,
  );
  assert.equal(occupy(cfg, 2), "1");
  assert.equal(
    withCheckoutSlot(cfg, 2, () => null),
    null,
  );
  assert.throws(() => occupy(cfg, THIRD_ISSUE), NO_SLOT);
});

test("failed claims retain surviving checkouts but reclaim reservations with no checkout", () => {
  const cfg = config({ laneSlots: 1 });
  assert.throws(() =>
    withCheckoutSlot(cfg, 1, () => {
      throw new Error("before creation");
    }),
  );
  assert.equal(occupy(cfg, 2), "1");
  fs.rmSync(paths.worktree(cfg, 2), { recursive: true });
  assert.throws(() =>
    withCheckoutSlot(cfg, THIRD_ISSUE, () => {
      fs.mkdirSync(paths.worktree(cfg, THIRD_ISSUE), { recursive: true });
      throw new Error("after creation");
    }),
  );
  assert.throws(() => occupy(cfg, FOURTH_ISSUE), NO_SLOT);
  assert.equal(slot(cfg, THIRD_ISSUE), "1");
});

test("all recorded stage and recovery paths must disappear before an issue releases its slot", () => {
  const cfg = config({ laneSlots: 1 });
  const first = withCheckout(cfg, {
    issue: 1,
    dir: paths.jobRepo(cfg, 1, "review"),
    branch: "feature/one",
  });
  const second = withCheckout(cfg, {
    issue: 1,
    dir: paths.jobRepo(cfg, 1, "merge"),
    branch: "feature/one",
  });
  assert.equal(occupy(first, 1), "1");
  assert.equal(occupy(second, 1), "1");
  fs.rmSync(paths.worktree(second, 1), { recursive: true });
  releaseCheckoutSlot(cfg);
  assert.throws(() => occupy(cfg, 2), NO_SLOT);
  assert.equal(slot(first, 1), "1");
  fs.rmSync(paths.worktree(first, 1), { recursive: true });
  const dropped = path.join(paths.runDir(cfg, 1), "dropped");
  fs.mkdirSync(dropped, { recursive: true });
  fs.writeFileSync(path.join(dropped, "saved.patch"), "recovery evidence\n");
  releaseCheckoutSlot(cfg);
  assert.equal(occupy(cfg, 2), "1");
  assert.equal(
    fs.readFileSync(path.join(dropped, "saved.patch"), "utf8"),
    "recovery evidence\n",
  );
});

test("failed lane setup retains the original checkout and slot until an explicit successful retry", () => {
  const cfg = config({
    laneSlots: 1,
    commands: { test: "true", setup: "printf original > local-work; exit 2" },
  });
  occupy(cfg, 1);
  assert.throws(
    () => setUpCheckout(cfg, 1, paths.worktree(cfg, 1), "setup.log"),
    SETUP_RETRY_REQUIRED,
  );
  assert.throws(() => removeWorktree(cfg, 1), SETUP_INCOMPLETE);
  assert.equal(
    fs.readFileSync(path.join(paths.worktree(cfg, 1), "local-work"), "utf8"),
    "original",
  );
  assert.throws(() => occupy(cfg, 2), NO_SLOT);
  setUpCheckout(
    { ...cfg, commands: { ...cfg.commands, setup: "true" } },
    1,
    paths.worktree(cfg, 1),
    "retry.log",
  );
  // Removal may now be attempted; a missing git clone still keeps the path.
  assert.doesNotThrow(() => removeWorktree(cfg, 1));
  assert.equal(slot(cfg, 1), "1");
});

test("failed worktree removal keeps the slot and legacy teardown still runs", () => {
  const marker = path.join(isolatedRoot, "teardown-marker");
  const cfg = config({
    laneSlots: 1,
    commands: {
      test: "true",
      setup: "true",
      teardown: `touch '${marker}'; exit 1`,
    },
  });
  assert.equal(occupy(cfg, 1), "1");
  setUpCheckout(cfg, 1, paths.worktree(cfg, 1), "setup.log");
  // No git clone exists, so the real git remove fails and leaves the directory.
  removeWorktree(cfg, 1);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(paths.worktree(cfg, 1)), true);
  assert.throws(() => occupy(cfg, 2), NO_SLOT);
});

test("setup receives its issue slot and secondary checkouts can only reuse that slot", () => {
  const cfg = config({
    commands: {
      test: "true",
      setup: "printf '%s' \"$ISSUE_PIPELINE_LANE_SLOT\" > assigned-slot",
    },
  });
  occupy(cfg, 1);
  occupy(cfg, 2);
  const secondary = path.join(isolatedRoot, "secondary-checkout");
  fs.mkdirSync(secondary);
  setUpCheckout(cfg, 2, secondary, "setup-copy.log");
  assert.equal(
    fs.readFileSync(path.join(secondary, "assigned-slot"), "utf8"),
    "2",
  );
  assert.throws(
    () => setUpCheckout(cfg, THIRD_ISSUE, secondary, "no-claim.log"),
    CLAIM_REQUIRED,
  );
});

test("missing or corrupt ownership fails closed before setup or destructive checkout cleanup", () => {
  const cfg = config();
  occupy(cfg, 1);
  const file = path.join(path.dirname(paths.runDir(cfg, 0)), "lane-slots.json");
  fs.writeFileSync(file, "not valid JSON");
  assert.throws(() => occupy(cfg, 2), OWNERSHIP_RECONCILIATION);
  assert.throws(
    () => assertCheckoutReadyForRemoval(cfg, 1, paths.worktree(cfg, 1)),
    OWNERSHIP_RECONCILIATION,
  );
  assert.throws(
    () =>
      setUpCheckout(
        { ...cfg, commands: { test: "true", setup: "true" } },
        1,
        paths.worktree(cfg, 1),
        "setup.log",
      ),
    OWNERSHIP_RECONCILIATION,
  );
  fs.unlinkSync(file);
  assert.throws(
    () => assertCheckoutReadyForRemoval(cfg, 1, paths.worktree(cfg, 1)),
    OWNERSHIP_MISSING,
  );
  assert.equal(fs.existsSync(paths.worktree(cfg, 1)), true);
});
