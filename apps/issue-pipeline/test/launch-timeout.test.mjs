// @ts-check
// A launch that runs past its time limit, ops or pi, loses its whole process
// group (#371, behaviour 7): its group gets SIGTERM, and SIGKILL once
// STOP_GRACE_MS has passed with its leader still running. Each test's
// launch ignores SIGTERM and starts a `sleep` in its group, so only a group
// SIGKILL ends them both.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { runOps } from "../src/job/ops-process.ts";
import { runRpc } from "../src/job/rpc.ts";
import {
  alive,
  endsWithTest,
  killGroup,
  waitFor,
} from "./bounded-test-kit.mjs";

// The launch: ignores SIGTERM, starts `sleep 600` in its own process group,
// writes its pid and the sleep's to `pids` in the folder it is given, and
// waits.
const STUBBORN = `import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const sleep = spawn("sleep", ["600"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2] + "/pids", process.pid + " " + sleep.pid + "\\n");
setInterval(() => {}, 60_000);
`;
// The launch's time limit. It only has to cover Node starting the launch and
// the launch writing two pids (web-tests-under-load); the rest of the launch
// waits. That took 95 ms at most over 30 launches, at a 1-minute load
// average of 53 on 10 cores (four busy loops per core), so 10 s is far over
// 3 times it.
const LAUNCH_TIMEOUT_MS = 10_000;
// How long a timed-out launch may take to end: LAUNCH_TIMEOUT_MS, then
// STOP_GRACE_MS (5 s) before the SIGKILL, then the kill itself (15.0 s in
// all, unloaded). It leaves 25 s for the kill, so a timer that never sends
// the group SIGKILL fails here, naming the launch.
const END_WITHIN_MS = 40_000;
const PIDS = /^(?<leader>\d+) (?<sleep>\d+)\n$/u;

/** @typedef {{ code: number | null, stdout: string, stderr: string, timedOut: boolean }} ProcessExit */

/** @returns {string} a fresh folder for one test's launch and its pids */
function tempDir() {
  const dir = fs.mkdtempSync("/tmp/issue-pipeline-launch-");
  endsWithTest(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The launch's pid and its sleep's, from `dir`'s `pids`, once written.
 * @param {string} dir @returns {{ leader: number, sleep: number } | null}
 */
function pidsIn(dir) {
  const file = path.join(dir, "pids");
  if (!fs.existsSync(file)) {
    return null;
  }
  const { leader, sleep } =
    fs.readFileSync(file, "utf8").match(PIDS)?.groups ?? {};
  if (leader === undefined || sleep === undefined) {
    return null;
  }
  return { leader: Number(leader), sleep: Number(sleep) };
}

/**
 * Kills whatever is left of the launch whose pids `dir` holds when the test
 * ends.
 * @param {string} dir
 */
function endsLaunchWithTest(dir) {
  endsWithTest(() => {
    const pids = pidsIn(dir);
    if (pids !== null) {
      killGroup(pids.leader);
    }
  });
}

/**
 * The pids `dir`'s launch wrote, which it must have written.
 * @param {string} dir @returns {{ leader: number, sleep: number }}
 */
function writtenPids(dir) {
  const pids = pidsIn(dir);
  if (pids === null) {
    throw new Error("the launch wrote no pids");
  }
  return pids;
}

/**
 * How `launch` ended, once it has, within END_WITHIN_MS.
 * @param {string} what @param {Promise<ProcessExit>} launch
 * @returns {Promise<ProcessExit>}
 */
async function endOf(what, launch) {
  let ended = false;
  launch.then(() => {
    ended = true;
  });
  await waitFor(`${what} to end`, () => ended, END_WITHIN_MS);
  return launch;
}

/**
 * Resolves once neither of the launch's processes is running.
 * @param {{ leader: number, sleep: number }} pids
 */
async function bothEnded({ leader, sleep }) {
  await waitFor("the launch to end", () => !alive(leader));
  await waitFor("the launch's sleep to end", () => !alive(sleep));
}

test("an ops launch that times out loses its whole group, SIGKILL for what ignores SIGTERM", async () => {
  const dir = tempDir();
  endsLaunchWithTest(dir);
  const script = path.join(dir, "stubborn.mjs");
  fs.writeFileSync(script, STUBBORN);
  const launch = runOps({
    key: "sweep",
    args: [script, dir],
    input: "",
    timeoutMs: LAUNCH_TIMEOUT_MS,
    started: () => null,
  });
  const exit = await endOf("the ops launch", launch);
  assert.equal(exit.timedOut, true);
  const pids = writtenPids(dir);
  await bothEnded(pids);
  assert.equal(alive(pids.sleep), false);
});

test("a pi launch that times out loses its whole group, SIGKILL for what ignores SIGTERM", async () => {
  const dir = tempDir();
  endsLaunchWithTest(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\n${STUBBORN}`, {
    mode: 0o755,
  });
  const { PATH: searchPath = "" } = process.env;
  const launch = runRpc({
    args: [dir],
    cwd: dir,
    env: Object.fromEntries([["PATH", `${bin}${path.delimiter}${searchPath}`]]),
    prompt: "hello",
    timeoutMs: LAUNCH_TIMEOUT_MS,
    onSpawn: () => null,
    onRecord: () => null,
  });
  const exit = await endOf("the pi launch", launch);
  assert.equal(exit.timedOut, true);
  const pids = writtenPids(dir);
  await bothEnded(pids);
  assert.equal(alive(pids.sleep), false);
});
