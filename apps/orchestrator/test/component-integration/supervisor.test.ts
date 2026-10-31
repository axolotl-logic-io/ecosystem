import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { checkOrchestrator } from "../../src/config.ts";
import {
  type Event,
  type Launch,
  runOrchestrator,
} from "../../src/supervisor.ts";

const DUPLICATE_ACCOUNT = /duplicate buddy name or account/u;
const DUPLICATE_FILE = /duplicate buddy entry/u;
const DUPLICATE_NAME = /duplicate buddy name/u;
const NO_PROGRAM = /no installed task app/u;
const RETIRED = /manifest field is retired/u;
const UNKNOWN = /Unrecognized/u;
const MISSING = /ENOENT/u;

const CHILD = `
process.on('SIGTERM', () => process.send('draining'));
process.on('message', message => {
  if (message === 'finish') process.exit(0);
  if (message === 'fail') process.exit(7);
});
process.send('ready');
`;

function fixture(): {
  root: string;
  file: string;
  buddies: string[];
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
  const launcher = path.join(root, "launcher.mjs");
  fs.writeFileSync(launcher, CHILD);
  fs.writeFileSync(path.join(root, "fix.mjs"), "");
  const repo = path.join(root, "repo.json");
  fs.writeFileSync(repo, JSON.stringify({ repo: "acme/widgets" }));
  const buddies = ["first", "second"].map((name) => {
    const file = path.join(root, `${name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        name,
        scope: { repositories: [repo] },
        tasks: ["fix"],
        account: {
          login: name,
          credentials: {
            file: path.join(root, "credentials"),
            variable: "TOKEN",
          },
        },
      }),
    );
    return file;
  });
  const file = path.join(root, "fleet.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, buddies, launcher }));
  return {
    root,
    file,
    buddies,
    cleanup: (): void => fs.rmSync(root, { recursive: true, force: true }),
  };
}

interface Running {
  child: ChildProcess;
  ready: Promise<void>;
  draining: Promise<void>;
}
function harness(): {
  children: Running[];
  start: (launch: Launch) => ChildProcess;
  report: (event: Event) => void;
  exited: Promise<void>;
  cleanup: () => void;
} {
  const children: Running[] = [];
  const exited = Promise.withResolvers<void>();
  return {
    children,
    exited: exited.promise,
    report: (event: Event): void => {
      if (event.kind === "exited") {
        exited.resolve();
      }
    },
    start: (launch: Launch): ChildProcess => {
      const child = spawn(
        process.execPath,
        [launch.launcher, "--config", launch.config],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      const ready = Promise.withResolvers<void>();
      const draining = Promise.withResolvers<void>();
      child.on("message", (message: unknown) => {
        if (message === "ready") {
          ready.resolve();
        }
        if (message === "draining") {
          draining.resolve();
        }
      });
      children.push({
        child,
        ready: ready.promise,
        draining: draining.promise,
      });
      return child;
    },
    cleanup: (): void => {
      for (const { child } of children) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    },
  };
}

test("invalid fleet refuses all starts, including cross-folder account reuse", async () => {
  const sandbox = fixture();
  const running = harness();
  try {
    const moved = path.join(sandbox.root, "other");
    fs.mkdirSync(moved);
    const [first, second] = sandbox.buddies;
    assert.ok(first);
    assert.ok(second);
    const raw = JSON.parse(fs.readFileSync(second, "utf8"));
    raw.account.login = "FIRST";
    const other = path.join(moved, "second.json");
    fs.writeFileSync(other, JSON.stringify(raw));
    fs.unlinkSync(second);
    const fleet = JSON.parse(fs.readFileSync(sandbox.file, "utf8"));
    fleet.buddies = [first, other];
    fs.writeFileSync(sandbox.file, JSON.stringify(fleet));
    await assert.rejects(
      runOrchestrator(
        sandbox.file,
        sandbox.root,
        new AbortController().signal,
        running,
      ),
      DUPLICATE_ACCOUNT,
    );
    assert.equal(running.children.length, 0);
  } finally {
    running.cleanup();
    sandbox.cleanup();
  }
});

test("duplicate files, names, missing programs, a retired manifest and unknown fields refuse validation", () => {
  const sandbox = fixture();
  try {
    const fleet = JSON.parse(fs.readFileSync(sandbox.file, "utf8"));
    const [first, second] = sandbox.buddies;
    assert.ok(first);
    assert.ok(second);
    fleet.buddies = [first, first];
    fs.writeFileSync(sandbox.file, JSON.stringify(fleet));
    assert.throws(
      () => checkOrchestrator(sandbox.file, sandbox.root),
      DUPLICATE_FILE,
    );
    fleet.buddies = sandbox.buddies;
    const buddy = JSON.parse(fs.readFileSync(second, "utf8"));
    buddy.name = "first";
    fs.writeFileSync(second, JSON.stringify(buddy));
    fs.writeFileSync(sandbox.file, JSON.stringify(fleet));
    assert.throws(
      () => checkOrchestrator(sandbox.file, sandbox.root),
      DUPLICATE_NAME,
    );
    buddy.name = "second";
    buddy.tasks = ["implement"];
    fs.writeFileSync(second, JSON.stringify(buddy));
    assert.throws(
      () => checkOrchestrator(sandbox.file, sandbox.root),
      NO_PROGRAM,
    );
    buddy.tasks = ["fix"];
    fs.writeFileSync(second, JSON.stringify(buddy));
    fleet.manifest = path.join(sandbox.root, "tasks.json");
    fs.writeFileSync(sandbox.file, JSON.stringify(fleet));
    assert.throws(() => checkOrchestrator(sandbox.file, sandbox.root), RETIRED);
    fleet.manifest = undefined;
    fleet.extra = true;
    fs.writeFileSync(sandbox.file, JSON.stringify(fleet));
    assert.throws(() => checkOrchestrator(sandbox.file, sandbox.root), UNKNOWN);
  } finally {
    sandbox.cleanup();
  }
});

test("two launchers drain independently and shutdown waits for in-flight work", async () => {
  const sandbox = fixture();
  const running = harness();
  try {
    const stop = new AbortController();
    const result = runOrchestrator(
      sandbox.file,
      sandbox.root,
      stop.signal,
      running,
    );
    await Promise.all(running.children.map(({ ready }) => ready));
    assert.equal(running.children.length, 2);
    const pids = new Set(running.children.map(({ child }) => child.pid));
    assert.equal(pids.size, 2);
    stop.abort();
    await Promise.all(running.children.map(({ draining }) => draining));
    let ended = false;
    result
      .then(() => {
        ended = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    assert.equal(ended, false);
    for (const { child } of running.children) {
      child.send("finish");
    }
    assert.deepEqual(await result, { kind: "stopped", failed: [] });
  } finally {
    running.cleanup();
    sandbox.cleanup();
  }
});

test("failed launcher is reported without restarting or stopping its healthy sibling", async () => {
  const sandbox = fixture();
  const running = harness();
  try {
    const stop = new AbortController();
    const result = runOrchestrator(
      sandbox.file,
      sandbox.root,
      stop.signal,
      running,
    );
    await Promise.all(running.children.map(({ ready }) => ready));
    const [first, second] = running.children;
    assert.ok(first);
    assert.ok(second);
    first.child.send("fail");
    await running.exited;
    assert.equal(second.child.exitCode, null);
    assert.equal(running.children.length, 2);
    stop.abort();
    const { draining } = second;
    await draining;
    second.child.send("finish");
    assert.deepEqual(await result, { kind: "stopped", failed: ["first"] });
  } finally {
    running.cleanup();
    sandbox.cleanup();
  }
});

test("partial process-start failure cleans up already started children", async () => {
  const sandbox = fixture();
  const running = harness();
  try {
    let attempts = 0;
    const result = runOrchestrator(
      sandbox.file,
      sandbox.root,
      new AbortController().signal,
      {
        report: running.report,
        start: (launch: Launch): ChildProcess => {
          attempts += 1;
          if (attempts === 2) {
            return spawn(path.join(sandbox.root, "missing-program"));
          }
          return running.start(launch);
        },
      },
    );
    await assert.rejects(result, MISSING);
    assert.equal(attempts, 2);
    for (const { child } of running.children) {
      assert.notEqual(child.signalCode, null);
    }
  } finally {
    running.cleanup();
    sandbox.cleanup();
  }
});

test("an already stopped orchestrator starts no children", async () => {
  const sandbox = fixture();
  const running = harness();
  try {
    const stop = AbortSignal.abort();
    assert.deepEqual(
      await runOrchestrator(sandbox.file, sandbox.root, stop, running),
      {
        kind: "stopped",
        failed: [],
      },
    );
    assert.equal(running.children.length, 0);
  } finally {
    running.cleanup();
    sandbox.cleanup();
  }
});
