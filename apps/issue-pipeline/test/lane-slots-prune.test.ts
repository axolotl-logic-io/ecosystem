import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.ts";
import { config, occupy, slot } from "./lane-slots-test-kit.ts";

const { paths, withCheckout }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const {
  pruneLaneResources,
  releaseCheckoutSlot,
}: typeof import("../src/lane-slots.ts") = await import("../src/lane-slots.ts");
const HOUR_MS = 3_600_000;
const THIRD_ISSUE = 3;
const PRUNE_EXIT = /exit 7/u;
const POOL_DRAIN_REQUIRED = /drain.*restore the pool/u;
test("prune runs from the base clone with the count, once per hour including failures", () => {
  const marker = path.join(isolatedRoot, "prune-attempts");
  const raw = {
    repo: "lanes/durable-prune",
    commands: {
      test: "true",
      prune: `printf '%s:%s\\n' "$PWD" "$ISSUE_PIPELINE_LANE_SLOTS" >> '${marker}'; exit 7`,
    },
  };
  const cfg = config(raw);
  fs.mkdirSync(paths.clone(cfg), { recursive: true });
  const scoped = withCheckout(cfg, {
    issue: 1,
    dir: path.join(isolatedRoot, "not-the-base"),
    branch: "feature/one",
  });
  let now = HOUR_MS;
  pruneLaneResources(scoped, () => now);
  now += HOUR_MS - 1;
  pruneLaneResources(config(raw), () => now);
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 1);
  now += 1;
  pruneLaneResources(scoped, () => now);
  const attempts = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.deepEqual(
    attempts,
    new Array(2).fill(`${fs.realpathSync(paths.clone(cfg))}:2`),
  );
  const log = path.join(path.dirname(paths.runDir(cfg, 0)), "prune.log");
  assert.match(fs.readFileSync(log, "utf8"), PRUNE_EXIT);
});

test("shrinking a pool retains out-of-range owners and suppresses prune until they are gone", () => {
  const marker = path.join(isolatedRoot, "shrink-pruned");
  const cfg = config({
    commands: { test: "true", prune: `touch '${marker}'` },
  });
  fs.mkdirSync(paths.clone(cfg), { recursive: true });
  occupy(cfg, 1);
  occupy(cfg, 2);
  const shrunk = { ...cfg, laneSlots: 1 };
  assert.throws(() => occupy(shrunk, 2), POOL_DRAIN_REQUIRED);
  pruneLaneResources(shrunk, () => HOUR_MS);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(paths.worktree(cfg, 1), { recursive: true });
  assert.equal(occupy(shrunk, THIRD_ISSUE), "1");
  assert.equal(slot(cfg, 2), "2");
  fs.rmSync(paths.worktree(cfg, 2), { recursive: true });
  releaseCheckoutSlot(shrunk);
  pruneLaneResources(shrunk, () => HOUR_MS);
  assert.equal(fs.existsSync(marker), true);
});

test("prune stays disabled without a pool or command", () => {
  const marker = path.join(isolatedRoot, "disabled-prune");
  const cfg = config({
    laneSlots: undefined,
    commands: { test: "true", prune: `touch '${marker}'` },
  });
  pruneLaneResources(cfg);
  pruneLaneResources(config());
  assert.equal(fs.existsSync(marker), false);
});
