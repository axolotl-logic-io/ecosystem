// @ts-check
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { endsWithTest } from "./bounded-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");
const { loadConfig, paths } = await import("../src/config.ts");
const { assertCheckoutReadyForRemoval } = await import("../src/lane-slots.ts");
const REPLY = z.object({
  slot: z.string().optional(),
  error: z.string().optional(),
  pruned: z.boolean().optional(),
});
const CHILD = new URL("./lane-slots-child-test-kit.mjs", import.meta.url);
const THIRD_ISSUE = 3;
const CRASH_CODE = 23;
let cases = 0;

/** @param {number} laneSlots @param {object} [commands] @returns {string} */
function configuration(laneSlots, commands = { test: "true" }) {
  cases += 1;
  const { cfg } = testConfig({
    repo: `races/case-${cases}`,
    laneSlots,
    commands,
  });
  const file = path.join(isolatedRoot, `race-${cases}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  fs.mkdirSync(paths.clone(cfg), { recursive: true });
  return file;
}

/** @param {string} config @param {number} issue @param {"claim" | "crash" | "prune" | "pending"} [mode] */
async function prepared(config, issue, mode = "claim") {
  const child = fork(CHILD, [config, mode, String(issue)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exit = once(child, "exit");
  const output = once(child, "message");
  endsWithTest(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exit;
  });
  const [ready] = await output;
  z.object({ ready: z.literal(true) }).parse(ready);
  const reply = once(child, "message");
  return {
    start() {
      child.send({ start: true });
    },
    async result() {
      const [message] = await reply;
      const [code] = await exit;
      if (code !== 0) {
        throw new Error(`slot child exited ${String(code)}`);
      }
      return REPLY.parse(message);
    },
    async crashed() {
      const [code] = await exit;
      return code;
    },
  };
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
