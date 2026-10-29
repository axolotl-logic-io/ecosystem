// Public boundaries on disposable machines. Authority comes from qualified
// human label events and real attempts; only GitHub/model transports fake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { ACTION_RUN } from "../../../src/runtime/observations.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { HARDENING, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const RAW = z.record(z.string(), z.unknown());
const REPLY = z.looseObject({ ok: z.boolean(), error: z.string().optional() });
const OTHER = 9;
const SCOPED_POLLS = 5;
const STOP_AFTER_IDLE = 3;
// The interrupted session, then the other issue's writing and hardening.
const INTERRUPTED_THEN_IMPLEMENTED = 3;
const REPLAY_REFUSED = /setup already started; it is not replayed/u;
const TASK_REFUSED = /land|responsibilit/u;
const PID = /^[1-9][0-9]*$/u;
const CI_POLICY = /requireCi/u;
const WAIT: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: true,
  reply: null,
};
const COMMIT: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "another counter\n",
    message: "Count for another issue",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted for the other issue." },
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
  } else {
    process.stderr.write(`Boundary evidence retained at ${box.root}\n`);
  }
}

function sessionStarted(box: Machine, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    function close(): void {
      watcher.close();
      signal.removeEventListener("abort", abort);
    }
    function abort(): void {
      close();
      reject(signal.reason);
    }
    function check(): void {
      if (box.launches().length > 0) {
        close();
        resolve();
      }
    }
    const watcher = fs.watch(path.join(box.root, "pi.log"), check);
    watcher.on("error", (error) => {
      close();
      reject(error);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    } else {
      check();
    }
  });
}

function ops(box: Machine, request: object): z.infer<typeof REPLY> {
  const { PATH: inherited = "" } = process.env;
  const result = spawnSync(
    process.execPath,
    [path.join(box.pipeline, "ops.mjs")],
    {
      encoding: "utf8",
      input: `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST\n`,
      env: {
        ...process.env,
        ...Object.fromEntries([
          [
            "PATH",
            `${path.join(box.root, "bin")}${path.delimiter}${inherited}`,
          ],
          ["ISSUE_PIPELINE_ROOT", box.pipeline],
          ["FAKE_GH_WORLD", path.join(box.root, "world.json")],
          ["FAKE_GH_LOG", path.join(box.root, "gh.log")],
          ["FAKE_GH_ORIGIN", box.origin],
        ]),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`ops crashed: ${result.stderr}`);
  }
  return REPLY.parse(JSON.parse(result.stdout));
}

test("an issue-scoped interruption leaves another issue able to implement", async ({
  signal,
}) => {
  const box = machine((world) => {
    const original = world.issues.find((issue) => issue.number === ISSUE);
    if (original === undefined) {
      throw new Error("missing initial human issue");
    }
    const other = structuredClone(original);
    other.number = OTHER;
    other.title = "Count for a different issue";
    other.events = other.events.map((event, index) => ({
      ...event,
      id: world.nextId + index,
    }));
    world.nextId += other.events.length;
    world.issues.push(other);
  });
  let passed = false;
  try {
    const outcome = await box.runBuddy(
      [{ ...WAIT, change: "stop-issue" }, COMMIT, HARDENING],
      SCOPED_POLLS,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    assert.equal(outcome.status, 0, outcome.stderr);
    const [interrupted] = outcome.actions;
    assert.equal(outcome.actions.length, 1);
    assert.equal(interrupted?.verdict, "unknown");
    assert.equal(interrupted?.stop, null);
    assert.equal(interrupted?.ownership.state, "released");
    const other = box.world().issues.find((issue) => issue.number === OTHER);
    assert.ok(other !== undefined);
    const records = marked(box.world(), "task-result", OTHER);
    assert.deepEqual(
      records.map((record) => [record.kind, record.verdict ?? null]),
      [
        ["attempt", null],
        ["result", "passed"],
      ],
    );
    assert.equal(box.launches().length, INTERRUPTED_THEN_IMPLEMENTED);
    assert.equal(
      box.git(["show", `agent/issue-${OTHER}:counter.txt`]),
      "another counter",
    );
    // The interrupted issue's draft branch holds no work.
    assert.equal(
      box.git(["diff", "--name-only", `main...agent/issue-${ISSUE}`]),
      "",
    );
    const stops = marked(box.world(), "signal").filter((record) =>
      JSON.stringify(record).includes('"label":"agents:stop"'),
    );
    assert.equal(stops.length, 1);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("replayed preparation and a task-spoofed envelope start no additional setup", async ({
  signal,
}) => {
  const box = machine(undefined, {
    landPermission: false,
    laneSlots: 1,
    setup: 'printf "setup\\n" >> "$ISSUE_PIPELINE_ROOT/../setup-runs"',
  });
  const control = new AbortController();
  const cancellation = AbortSignal.any([signal, control.signal]);
  const running = box.runBuddy(
    [WAIT],
    STOP_AFTER_IDLE,
    undefined,
    cancellation,
  );
  let passed = false;
  try {
    await Promise.race([
      sessionStarted(box, cancellation),
      running.then((outcome) => {
        throw new Error(
          `buddy ended before waiting session: ${outcome.stderr}`,
        );
      }),
    ]);
    const directory = path.join(
      box.pipeline,
      "runs",
      "acme__widgets",
      `issue-${ISSUE}`,
      "actions",
    );
    const [id] = fs.readdirSync(directory);
    if (id === undefined) {
      throw new Error("running action is missing");
    }
    const action = ACTION_RUN.parse(
      JSON.parse(fs.readFileSync(path.join(directory, id, "run.json"), "utf8")),
    );
    const [launch] = box.launches();
    if (launch === undefined) {
      throw new Error("waiting session is missing");
    }
    const checkout = path.join(launch.cwd, "repo");
    const buddy = {
      config: path.join(box.root, "buddy.json"),
      run: action.buddyRun,
      task: action.task,
      authorizationDigest: action.authorization,
    };
    const request = {
      op: "prepare-checkout",
      config: path.join(box.root, "repo.json"),
      number: ISSUE,
      execution: action.execution,
      buddy,
      checkout: {
        issue: ISSUE,
        dir: checkout,
        branch: git(checkout, ["symbolic-ref", "--short", "HEAD"]),
      },
    };
    const before = marked(box.world(), "task-result");
    // These are the real running action's original bindings, not a forged
    // attempt or a caller-created grant. Only the op request is replayed.
    const replay = ops(box, request);
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? "", REPLAY_REFUSED);
    const spoofed = ops(box, { ...request, buddy: { ...buddy, task: "land" } });
    assert.equal(spoofed.ok, false);
    assert.match(spoofed.error ?? "", TASK_REFUSED);
    assert.equal(
      fs.readFileSync(path.join(box.root, "setup-runs"), "utf8"),
      "setup\n",
    );
    assert.deepEqual(marked(box.world(), "task-result"), before);
    // A real human stop ends the waiting model; no result is fabricated.
    box.change((world) => {
      const issue = world.issues.find((item) => item.number === ISSUE);
      if (issue === undefined) {
        throw new Error("running issue is missing");
      }
      issue.labels.push("agents:stop");
      issue.events.push({
        id: world.nextId,
        event: "labeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T13:00:00Z",
      });
      world.nextId += 1;
    });
    const ended = await running;
    signal.throwIfAborted();
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(box.launches().length, 1);
    assert.equal(
      fs.readFileSync(path.join(box.root, "setup-runs"), "utf8"),
      "setup\n",
    );
    passed = true;
  } finally {
    control.abort();
    await running.catch(() => undefined);
    keep(box, passed);
  }
});

test("a SIGKILL during setup preserves its pending barrier and never launches or replays a session", async ({
  signal,
}) => {
  const box = machine(undefined, {
    landPermission: false,
    laneSlots: 1,
    setup:
      'printf "%s\\n" "$$" >> "$ISSUE_PIPELINE_ROOT/../setup-pids"; kill -KILL "$$"',
  });
  let passed = false;
  try {
    const outcome = await box.runBuddy([], STOP_AFTER_IDLE, undefined, signal);
    signal.throwIfAborted();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.actions.length, 1);
    const [action] = outcome.actions;
    assert.equal(action?.ownership.state, "retained");
    assert.equal(box.launches().length, 0);
    const pids = fs
      .readFileSync(path.join(box.root, "setup-pids"), "utf8")
      .trim()
      .split("\n");
    assert.equal(pids.length, 1);
    assert.match(pids[0] ?? "", PID);
    const store = z
      .looseObject({
        leases: z.array(
          z.looseObject({
            issue: z.number(),
            pendingSetup: z.array(z.string()),
          }),
        ),
      })
      .parse(
        JSON.parse(
          fs.readFileSync(
            path.join(box.pipeline, "runs", "acme__widgets", "lane-slots.json"),
            "utf8",
          ),
        ),
      );
    assert.equal(store.leases.length, 1);
    assert.equal(store.leases[0]?.issue, ISSUE);
    assert.equal(store.leases[0]?.pendingSetup.length, 1);
    assert.equal(
      marked(box.world(), "task-result").filter(
        (record) => record.kind === "attempt",
      ).length,
      1,
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a malformed operator CI waiver refuses the built buddy before any run or model", () => {
  const box = machine();
  let passed = false;
  try {
    const config = path.join(box.root, "repo.json");
    const original = RAW.parse(JSON.parse(fs.readFileSync(config, "utf8")));
    fs.writeFileSync(
      config,
      JSON.stringify({ ...original, requireCi: "false" }),
    );
    const checked = spawnSync(
      process.execPath,
      [
        path.join(box.pipeline, "buddy.mjs"),
        "--config",
        path.join(box.root, "buddy.json"),
        "--check",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...Object.fromEntries([["ISSUE_PIPELINE_ROOT", box.pipeline]]),
        },
      },
    );
    assert.notEqual(checked.status, 0);
    assert.match(`${checked.stdout}\n${checked.stderr}`, CI_POLICY);
    assert.equal(box.launches().length, 0);
    assert.equal(
      fs.existsSync(path.join(box.pipeline, "runs", "buddy-runs")),
      false,
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});
