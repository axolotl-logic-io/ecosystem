import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { type Config, configure } from "../config.ts";
import {
  type BuddyRunObservation,
  taskRunSchema,
} from "../runtime-run-schema.ts";
import {
  type ActionRunEntry,
  type BuddyRunCondition,
  type BuddyRunEntry,
  loadRuntimeRuns,
  type RuntimeRuns,
} from "../runtime-runs.ts";
import {
  actionRun,
  actionRunPath,
  buddyRun,
  buddyRunPath,
  leaseSeconds,
  nodeProcess,
  repo,
  slug,
  taskRun,
  taskRunPath,
  writeObservation,
  writeText,
} from "./runtime-run-fixtures.ts";

const run = promisify(execFile);
const pipeline = fileURLToPath(new URL("../../issue-host/", import.meta.url));
const millisecondsPerHour = 3_600_000;
const oversizedBytes = 1_048_577;
const options = { timeout: 30_000 };
const issue = 7;
const fixtureHost = "fixture-elsewhere";
const pidReused = /pid may be reused/u;
const notEntrypoint = /doesn't run the buddy entrypoint/u;
const notRunning = /is not running/u;
const leaseExpired = /lease expired/u;
const otherHost = /recorded on host fixture-elsewhere/u;
const notProof = /isn't proof of the run's identity/u;
const anything = /(?:)/u;
const schemaMismatch = /schema at state:/u;
const wrongFolder = /under folder/u;
const wrongLocation = /under fixture-org\/fixture-repo#7\//u;
const misplacedTaskRun = /task run .* under fixture-org\/fixture-repo#8\//u;

async function runsRoot(context: TestContext): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), "workflow-dash-runtime-runs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return configure({ runs: join(root, "runs"), repos: [] });
}
function buddy(runtime: RuntimeRuns, id: string): BuddyRunEntry {
  const entry = runtime.buddyRuns.find((item) => item.run.id === id);
  if (entry === undefined) {
    throw new Error(`buddy run ${id} not observed`);
  }
  return entry;
}
function action(runtime: RuntimeRuns, id: string): ActionRunEntry {
  const entry = runtime.actionRuns.find((item) => item.run.id === id);
  if (entry === undefined) {
    throw new Error(`action run ${id} not observed`);
  }
  return entry;
}
function problem(runtime: RuntimeRuns, path: string): string {
  const found = runtime.problems.find((item) => item.path === path);
  if (found === undefined) {
    throw new Error(`no problem reported for ${path}`);
  }
  return found.reason;
}

test(
  "the task run reader schema equals the task framework's exported schema",
  options,
  async (context) => {
    const script = [
      'import { z } from "zod";',
      'const t = await import("./src/task-app/run-record.ts");',
      "process.stdout.write(JSON.stringify({ taskRun: z.toJSONSchema(t.TASK_RUN) }));",
    ].join("\n");
    const { stdout } = await run(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: pipeline, maxBuffer: 1_048_576, signal: context.signal },
    );
    const published: unknown = JSON.parse(stdout);
    assert.deepEqual(published, {
      taskRun: z.toJSONSchema(taskRunSchema),
    });
  },
);

test(
  "explicit links join buddy run, action run and session; an ended action stays ended",
  options,
  async (context) => {
    const config = await runsRoot(context);
    const folder = dirname(config.runs);
    const child = await nodeProcess(join(folder, "bin"), "buddy.mjs");
    context.after(() => child.kill());
    const buddyId = randomUUID();
    const previousId = randomUUID();
    const endedId = randomUUID();
    const runningId = randomUUID();
    const sessionId = randomUUID();
    const missingSession = randomUUID();
    const base = buddyRun(buddyId);
    await writeObservation(
      buddyRunPath(config.runs, buddyId),
      buddyRun(buddyId, {
        previous: previousId,
        process: { ...base.process, pid: child.pid },
        loops: [
          {
            task: "implement",
            repo,
            state: "acting",
            reason: null,
            polledAt: null,
            action: runningId,
          },
        ],
      }),
    );
    const session = {
      parent: endedId,
      agent: "fixture-agent",
      model: "fixture-model",
      phase: null,
      commits: false,
      pid: null,
      reservation: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: null,
    };
    await writeObservation(
      actionRunPath(config.runs, issue, endedId),
      actionRun(endedId, buddyId, issue, {
        state: "ended",
        outcome: "unknown",
        sessions: [
          { ...session, id: sessionId, key: "implement-1" },
          { ...session, id: missingSession, key: "implement-2" },
        ],
      }),
    );
    await writeText(
      join(
        dirname(actionRunPath(config.runs, issue, endedId)),
        "sessions",
        "implement-1.jsonl",
      ),
      "",
    );
    await writeObservation(
      actionRunPath(config.runs, issue, runningId),
      actionRun(runningId, randomUUID(), issue, { previous: endedId }),
    );

    const runtime = await loadRuntimeRuns(config);

    assert.deepEqual(runtime.problems, []);
    assert.deepEqual(runtime.coverage.repositories, [repo]);
    const observed = buddy(runtime, buddyId);
    assert.equal(observed.condition.state, "process-observed");
    assert.match(observed.condition.reason, notProof);
    assert.deepEqual(observed.actions, [endedId]);
    assert.equal(observed.previousObserved, false);
    assert.deepEqual(observed.warnings, []);
    const ended = action(runtime, endedId);
    assert.equal(ended.condition.state, "ended");
    assert.equal(ended.buddyRun.id, buddyId);
    assert.equal(ended.buddyRun.condition, "process-observed");
    assert.deepEqual(
      ended.sessions.map((link) => [
        link.id,
        link.fileState,
        link.parentMatches,
      ]),
      [
        [sessionId, "present", true],
        [missingSession, "missing", true],
      ],
    );
    assert.ok(ended.warnings.some((warning) => warning.includes("unknown")));
    const running = action(runtime, runningId);
    assert.equal(running.condition.state, "unconfirmed");
    assert.equal(running.buddyRun.condition, "not observed");
    assert.equal(running.previousObserved, true);
  },
);
test(
  "only a fresh, same-host Node buddy entrypoint with a matching start counts as process-observed",
  options,
  async (context) => {
    const config = await runsRoot(context);
    const folder = dirname(config.runs);
    const entrypoint = await nodeProcess(join(folder, "bin"), "buddy.mjs");
    const other = await nodeProcess(join(folder, "bin"), "not-buddy.mjs");
    const gone = await nodeProcess(join(folder, "gone"), "buddy.mjs");
    context.after(() => {
      entrypoint.kill();
      other.kill();
    });
    const exited = once(gone, "exit");
    gone.kill();
    await exited;
    const now = Date.now();
    function at(shift: number): string {
      return new Date(now + shift).toISOString();
    }
    const base = buddyRun(randomUUID()).process;
    const cases: {
      id: string;
      run: Partial<BuddyRunObservation>;
      expected: BuddyRunCondition["state"];
      reason: RegExp | null;
    }[] = [
      {
        id: randomUUID(),
        run: {
          process: {
            ...base,
            pid: entrypoint.pid,
            startedAt: at(millisecondsPerHour),
          },
        },
        expected: "stale",
        reason: pidReused,
      },
      {
        id: randomUUID(),
        run: { process: { ...base, pid: other.pid } },
        expected: "stale",
        reason: notEntrypoint,
      },
      {
        id: randomUUID(),
        run: { process: { ...base, pid: gone.pid } },
        expected: "stale",
        reason: notRunning,
      },
      {
        id: randomUUID(),
        run: { process: { ...base, host: fixtureHost } },
        expected: "unknown",
        reason: otherHost,
      },
      {
        id: randomUUID(),
        run: { lease: { seconds: leaseSeconds, expiresAt: at(-1) } },
        expected: "stale",
        reason: leaseExpired,
      },
      {
        id: randomUUID(),
        run: {
          state: "stopped",
          outcome: { kind: "stopped", reason: "fixture stop", at: at(0) },
        },
        expected: "stopped",
        reason: null,
      },
    ];
    await Promise.all(
      cases.map((item) =>
        writeObservation(
          buddyRunPath(config.runs, item.id),
          buddyRun(item.id, item.run),
        ),
      ),
    );

    const runtime = await loadRuntimeRuns(config);

    assert.deepEqual(
      cases.map((item) => buddy(runtime, item.id).condition.state),
      cases.map((item) => item.expected),
    );
    for (const item of cases) {
      assert.match(
        buddy(runtime, item.id).condition.reason,
        item.reason ?? anything,
      );
    }
  },
);

test(
  "unreadable, malformed, foreign and misplaced files are problems, never runs",
  options,
  async (context) => {
    const config = await runsRoot(context);
    function buddyPath(): string {
      return buddyRunPath(config.runs, randomUUID());
    }
    function idOf(path: string): string {
      return basename(dirname(path));
    }
    const paths = {
      malformed: buddyPath(),
      wrongKind: buddyPath(),
      wrongVersion: buddyPath(),
      mismatch: buddyPath(),
      misplaced: buddyPath(),
      oversized: buddyPath(),
      linked: buddyPath(),
      wrongIssue: actionRunPath(config.runs, issue, randomUUID()),
    };
    const target = join(dirname(config.runs), "outside.json");
    await Promise.all([
      writeText(paths.malformed, '{"kind":"buddy-run",'),
      writeObservation(paths.wrongKind, {
        ...buddyRun(idOf(paths.wrongKind)),
        kind: "action-run",
      }),
      writeObservation(paths.wrongVersion, {
        ...buddyRun(idOf(paths.wrongVersion)),
        version: 2,
      }),
      writeObservation(paths.mismatch, {
        ...buddyRun(idOf(paths.mismatch)),
        state: "healthy",
      }),
      writeObservation(paths.misplaced, buddyRun(randomUUID())),
      writeText(paths.oversized, " ".repeat(oversizedBytes)),
      writeObservation(target, buddyRun(idOf(paths.linked))),
      mkdir(dirname(paths.linked), { recursive: true }),
      writeObservation(
        paths.wrongIssue,
        actionRun(idOf(paths.wrongIssue), randomUUID(), issue + 1),
      ),
    ]);
    await symlink(target, paths.linked);

    const runtime = await loadRuntimeRuns(
      configure({ runs: config.runs, repos: [repo] }),
    );

    assert.deepEqual(runtime.buddyRuns, []);
    assert.deepEqual(runtime.actionRuns, []);
    assert.equal(runtime.problems.length, Object.keys(paths).length);
    assert.equal(problem(runtime, paths.malformed), "invalid JSON");
    assert.equal(
      problem(runtime, paths.wrongKind),
      "not a buddy-run observation",
    );
    assert.equal(problem(runtime, paths.wrongVersion), "unsupported version 2");
    assert.match(problem(runtime, paths.mismatch), schemaMismatch);
    assert.match(problem(runtime, paths.misplaced), wrongFolder);
    assert.equal(
      problem(runtime, paths.oversized),
      "exceeds the 1048576-byte read bound",
    );
    assert.equal(problem(runtime, paths.linked), "not a regular file");
    assert.match(problem(runtime, paths.wrongIssue), wrongLocation);
  },
);

test(
  "a missing runs folder is reported as unlistable coverage",
  options,
  async (context) => {
    const config = await runsRoot(context);
    const runtime = await loadRuntimeRuns(config);
    assert.deepEqual(runtime.buddyRuns, []);
    assert.deepEqual(runtime.coverage.unlistable, [
      join(config.runs, "buddy-runs"),
    ]);
    assert.equal(runtime.coverage.root, config.runs);
    assert.equal(slug, repo.replace("/", "__"));
  },
);

test(
  "task runs show their recorded end, or whether their process still runs",
  options,
  async (context) => {
    const config = configure({
      runs: (await runsRoot(context)).runs,
      repos: [repo],
    });
    const live = await nodeProcess(join(dirname(config.runs), "bin"), "x.mjs");
    context.after(() => live.kill());
    const gone = await nodeProcess(join(dirname(config.runs), "bin"), "y.mjs");
    gone.kill();
    await once(gone, "exit");
    const [ended, running, crashed, misplaced] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await writeObservation(
      taskRunPath(config.runs, issue, ended),
      taskRun(ended, issue, {
        state: "ended",
        step: "unmark",
        outcome: "failed",
        reason: "the model went away",
        endedAt: new Date().toISOString(),
      }),
    );
    await writeObservation(
      taskRunPath(config.runs, issue, running),
      taskRun(running, issue, {
        process: { pid: live.pid, host: hostname() },
      }),
    );
    await writeObservation(
      taskRunPath(config.runs, issue, crashed),
      taskRun(crashed, issue, { process: { pid: gone.pid, host: hostname() } }),
    );
    await writeObservation(
      taskRunPath(config.runs, issue + 1, misplaced),
      taskRun(misplaced, issue),
    );
    const runtime = await loadRuntimeRuns(config);
    const conditions = new Map(
      runtime.taskRuns.map((entry) => [entry.run.id, entry.condition.state]),
    );
    assert.equal(conditions.get(ended), "ended");
    assert.equal(conditions.get(running), "process-observed");
    assert.equal(conditions.get(crashed), "stale");
    assert.equal(conditions.has(misplaced), false);
    assert.match(
      problem(runtime, taskRunPath(config.runs, issue + 1, misplaced)),
      misplacedTaskRun,
    );
  },
);
