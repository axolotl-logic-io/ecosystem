// @ts-check
// `shell` (src/process.ts) leaves no process behind (#371): each command
// runs in a process group of its own, which is emptied when bash exits, when
// the command times out and when the op running it dies, and the log names
// what was killed. Each command but the first runs in a driver process of
// its own group that imports `shell`, as ops.mjs does, so a shell that never
// returns fails at a deadline instead of blocking the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { shell } from "../src/process.ts";
import { groupAlive } from "../src/process-group.ts";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "./bounded-test-kit.mjs";

const PROCESS = new URL("../src/process.ts", import.meta.url).pathname;
// The driver: runs shell() on the request in its argument, logging to
// shell.log in the request's folder, and prints the result as JSON.
const DRIVER = `const [file, json] = process.argv.slice(1);
const { shell } = await import(file);
const { command, dir, timeoutMs } = JSON.parse(json);
process.stdout.write(JSON.stringify(shell(command, dir, dir + "/shell.log", timeoutMs)));`;
// The time limit of a command that must time out. It only has to cover two
// `echo`s under load (web-tests-under-load); the rest of the command waits.
const TIMEOUT_MS = 10_000;
// The code `shell` gives a command that timed out.
const TIMED_OUT_CODE = 124;
// The time limit of a command that must not time out.
const LONG_TIMEOUT_MS = 60_000;
// How long a driver's shell() may take to return: TIMEOUT_MS, then the
// supervisor's SIGTERM grace (2 s) and the wait for its group to empty.
// That took 12.2 s at most, at a 1-minute load average of 25 on 10 cores
// (one busy loop per core beside the pipeline's whole suite). It is over 3
// times that, and below LONG_TIMEOUT_MS, so a shell that waits for its
// command's pipes until the time limit fails here.
const RETURN_WITHIN_MS = 40_000;
const KILLED_GROUP =
  /--- killed process group (?<pgid>\d+) \(pids [\d, ]+\): /u;
const TERM_THEN_KILL = /: SIGTERM, then SIGKILL ---\n$/u;
const TERM_ONLY = /: SIGTERM ---\n$/u;
// A command that ignores SIGTERM, as do its background child and bash, and
// writes both pids before it waits.
const IGNORES_TERM =
  "trap '' TERM; echo $$ > group.pid; sleep 600 & echo $! > child.pid; wait";

// The modules `shell` loads, which a test copies without the supervisor
// that sits beside them in src/.
const SHELL_MODULES = ["process.ts", "pipeline-root.ts", "shell-protocol.ts"];

/** @typedef {{ code: number, log: string | undefined, tail: string }} ShellResult */

/** @returns {string} a fresh folder for one test's pid files and log */
function tempDir() {
  const dir = fs.mkdtempSync("/tmp/issue-pipeline-shell-");
  endsWithTest(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The pid in `dir`'s file `name`, which the command must have written.
 * @param {string} dir @param {string} name @returns {number}
 */
function writtenPid(dir, name) {
  const pid = pidIn(dir, name);
  if (pid === null) {
    throw new Error(`the command wrote no ${name}`);
  }
  return pid;
}

/** @param {string} dir @param {string} name */
function killWritten(dir, name) {
  const pid = pidIn(dir, name);
  if (pid === null) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH: it has ended.
  }
}

/**
 * Starts a driver, in a process group of its own, that runs `command` in
 * `dir` with `shell`. Whatever is left of it, and of the command's group and
 * child, is killed when the test ends.
 * @param {string} dir @param {string} command @param {number} timeoutMs
 * @returns {{ pid: number, output: () => string | null }}
 */
function startShell(dir, command, timeoutMs) {
  const request = JSON.stringify({ command, dir, timeoutMs });
  const driver = spawn(
    process.execPath,
    ["--input-type=module", "-e", DRIVER, PROCESS, request],
    { cwd: dir, detached: true, stdio: ["ignore", "pipe", "inherit"] },
  );
  const { pid } = driver;
  if (pid === undefined) {
    throw new Error("the driver didn't start");
  }
  endsWithTest(() => {
    killGroup(pid);
    const group = pidIn(dir, "group.pid");
    if (group !== null) {
      killGroup(group);
    }
    killWritten(dir, "child.pid");
  });
  let stdout = "";
  /** @type {string | null} */
  let output = null;
  driver.stdout.setEncoding("utf8");
  driver.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  driver.on("close", () => {
    output = stdout;
  });
  return { pid, output: () => output };
}

/**
 * What `shell` returned for `command`, once the driver has printed it.
 * @param {string} dir @param {string} command @param {number} timeoutMs
 * @returns {Promise<ShellResult>}
 */
async function shellIn(dir, command, timeoutMs) {
  const { output } = startShell(dir, command, timeoutMs);
  await waitFor("shell to return", () => output() !== null, RETURN_WITHIN_MS);
  return JSON.parse(output() ?? "");
}

/** @param {string} dir @returns {string} */
function logIn(dir) {
  return fs.readFileSync(path.join(dir, "shell.log"), "utf8");
}

test("a command that leaves nothing running is logged as before, with bash's code", () => {
  const dir = tempDir();
  const log = path.join(dir, "shell.log");
  const command = "echo out; echo err >&2; exit 3";
  const result = shell(command, dir, log, LONG_TIMEOUT_MS);
  assert.deepEqual(result, { code: 3, log, tail: "out\n\nerr" });
  assert.equal(
    logIn(dir),
    `$ ${command}\n--- stdout ---\nout\n\n--- stderr ---\nerr\n\n--- exit 3 ---\n`,
  );
});

test("a timeout kills the command's whole group, SIGKILL for what ignores SIGTERM, and logs it", async () => {
  const dir = tempDir();
  const result = await shellIn(dir, IGNORES_TERM, TIMEOUT_MS);
  assert.equal(result.code, TIMED_OUT_CODE);
  const log = logIn(dir);
  const group = writtenPid(dir, "group.pid");
  const { pgid } = log.match(KILLED_GROUP)?.groups ?? {};
  assert.equal(pgid, String(group));
  assert.match(log, TERM_THEN_KILL);
  assert.equal(alive(group), false);
  assert.equal(alive(writtenPid(dir, "child.pid")), false);
});

test("a command that exits returns at once with bash's code, and its background child is killed", async () => {
  const dir = tempDir();
  const command = "sleep 600 & echo $! > child.pid; exit 0";
  const result = await shellIn(dir, command, LONG_TIMEOUT_MS);
  assert.equal(result.code, 0);
  assert.equal(alive(writtenPid(dir, "child.pid")), false);
  const log = logIn(dir);
  assert.match(log, KILLED_GROUP);
  assert.match(log, TERM_ONLY);
});

test("when the op running a command dies of SIGTERM, the command's group is killed", async () => {
  const dir = tempDir();
  const driver = startShell(dir, IGNORES_TERM, LONG_TIMEOUT_MS);
  await waitFor("the command's pids", () => pidIn(dir, "child.pid") !== null);
  process.kill(-driver.pid, "SIGTERM");
  await waitFor("the driver's group to end", () => !groupAlive(driver.pid));
  assert.equal(alive(writtenPid(dir, "group.pid")), false);
  assert.equal(alive(writtenPid(dir, "child.pid")), false);
});

/**
 * `shell` from a copy of its modules in `dir`, with no shell supervisor
 * beside them, and zod's packages linked in.
 * @param {string} dir @returns {Promise<typeof shell>}
 */
async function shellWithoutSupervisor(dir) {
  for (const name of SHELL_MODULES) {
    const source = new URL(`../src/${name}`, import.meta.url);
    fs.copyFileSync(source, path.join(dir, name));
  }
  const zod = createRequire(import.meta.url).resolve("zod/package.json");
  const packages = path.dirname(path.dirname(zod));
  fs.symlinkSync(packages, path.join(dir, "node_modules"));
  const copy = await import(path.join(dir, "process.ts"));
  return copy.shell;
}

test("a missing shell supervisor fails the command without running it", async () => {
  const dir = tempDir();
  const runShell = await shellWithoutSupervisor(dir);
  const log = path.join(dir, "shell.log");
  const result = runShell("echo ran > ran.txt", dir, log, LONG_TIMEOUT_MS);
  assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(path.join(dir, "ran.txt")), false);
});
