import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { isolatedRoot } from "./isolated-root-test-kit.ts";
import { prepared } from "./lane-slots-race-test-kit.ts";

const { testConfig }: typeof import("./config-test-kit.ts") = await import(
  "./config-test-kit.ts"
);
const { loadConfig, paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { assertCheckoutReadyForRemoval }: typeof import("../src/lane-slots.ts") =
  await import("../src/lane-slots.ts");
const THIRD_ISSUE = 3;
const CRASH_CODE = 23;
let cases = 0;

function configuration(
  laneSlots: number,
  commands: object = { test: "true" },
): string {
  cases += 1;
  const { cfg } = testConfig({
    repo: `races/case-${cases}`,
    laneSlots,
    commands,
  });
  const file = path.join(isolatedRoot, `race-${cases}.json`);
  // Only this legacy-flat fixture is reloaded; computed authority is not input.
  const { policyBinding: _binding, slug: _slug, ...raw } = cfg;
  fs.writeFileSync(file, JSON.stringify(raw));
  fs.mkdirSync(paths.clone(cfg), { recursive: true });
  return file;
}

const SETUP_INCOMPLETE = /setup is incomplete/u;
const NO_FREE_SLOT = /no free lane slot/u;
const NO_SLOT_RETRY = /no free lane slot.*retry/u;
test("concurrent claim processes cannot share a slot or partially claim an exhausted pool", async () => {
  const file = configuration(2);
  const children = await Promise.all([
    prepared(file, 1),
    prepared(file, 2),
    prepared(file, THIRD_ISSUE),
  ]);
  for (const child of children) {
    child.start();
  }
  const replies = await Promise.all(children.map((child) => child.result()));
  const slots = replies.flatMap((reply) => reply.slot ?? []).sort();
  assert.deepEqual(slots, ["1", "2"]);
  const errors = replies.flatMap((reply) => reply.error ?? []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", NO_SLOT_RETRY);
});

test("a crashed owner keeps its surviving checkout slot across independent process restarts", async () => {
  const file = configuration(1);
  const crashing = await prepared(file, 1, "crash");
  crashing.start();
  assert.equal(await crashing.crashed(), CRASH_CODE);
  const other = await prepared(file, 2);
  other.start();
  assert.match((await other.result()).error ?? "", NO_FREE_SLOT);
  const reclaim = await prepared(file, 1);
  reclaim.start();
  assert.equal((await reclaim.result()).slot, "1");
});

test("an interrupted setup retains its original checkout and pending readiness after process restart", async () => {
  const file = configuration(1);
  const child = await prepared(file, 1, "pending");
  child.start();
  assert.equal(await child.crashed(), CRASH_CODE);
  const cfg = loadConfig(file);
  const dir = paths.worktree(cfg, 1);
  assert.throws(
    () => assertCheckoutReadyForRemoval(cfg, 1, dir),
    SETUP_INCOMPLETE,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "local-work"), "utf8"),
    "original\n",
  );
  const other = await prepared(file, 2);
  other.start();
  assert.match((await other.result()).error ?? "", NO_FREE_SLOT);
});

test("concurrent maintenance processes share the durable hourly throttle", async () => {
  const marker = path.join(isolatedRoot, "prune-race-attempts");
  const file = configuration(2, {
    test: "true",
    prune: `printf 'attempt\\n' >> '${marker}'`,
  });
  const children = await Promise.all([
    prepared(file, 1, "prune"),
    prepared(file, 2, "prune"),
  ]);
  for (const child of children) {
    child.start();
  }
  const replies = await Promise.all(children.map((child) => child.result()));
  assert.deepEqual(replies, [{ pruned: true }, { pruned: true }]);
  assert.equal(fs.readFileSync(marker, "utf8"), "attempt\n");
  const { ISSUE_PIPELINE_ROOT } = process.env;
  assert.equal(ISSUE_PIPELINE_ROOT, isolatedRoot);
});

const COMPUTED_BINDING =
  /slot child readiness; mode=claim; issue=1; code=1; signal=null;[\s\S]*policyBinding is computed, not a configuration setting/u;
test("a child configuration failure rejects readiness with the original loader diagnostic", async () => {
  const file = configuration(1);
  const raw = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(file, JSON.stringify({ ...raw, policyBinding: null }));
  await assert.rejects(prepared(file, 1), COMPUTED_BINDING);
});

const MISSING_REPLY =
  /slot child reply; mode=crash; issue=1; code=23; signal=null/u;
test("a child exit without a reply rejects even when it preceded the result wait", async () => {
  const file = configuration(1);
  const child = await prepared(file, 1, "crash");
  child.start();
  assert.equal(await child.crashed(), CRASH_CODE);
  await assert.rejects(child.result(), MISSING_REPLY);
});
