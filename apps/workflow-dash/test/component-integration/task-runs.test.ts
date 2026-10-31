import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loadTaskRuns, type TaskRuns, taskRunSchema } from "../../task-runs.ts";
import {
  nodeProcess,
  repo,
  taskRun,
  taskRunPath,
  writeRecord,
  writeText,
} from "../support/task-run-fixtures.ts";

const run = promisify(execFile);
const issueHost = fileURLToPath(
  new URL("../../../issue-host/", import.meta.url),
);
const oversizedBytes = 1_048_577;
const options = { timeout: 30_000 };
const issue = 7;
const pidReused = /pid may be reused/u;
const notRunning = /is not running/u;
const otherHost = /on host fixture-elsewhere/u;
const notRecord = /not a task run record at/u;
const misplaced = /task run .* under fixture-org\/fixture-repo#8\//u;

async function runsFolder(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workflow-dash-task-runs-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "runs");
}
function problem(taskRuns: TaskRuns, path: string): string {
  const found = taskRuns.problems.find((item) => item.path === path);
  if (found === undefined) {
    throw new Error(`no problem reported for ${path}`);
  }
  return found.reason;
}

test(
  "the reader's schema equals the task framework's exported schema",
  options,
  async (context) => {
    const script = [
      'import { z } from "zod";',
      'const t = await import("./src/task-app/run-record.ts");',
      "process.stdout.write(JSON.stringify(z.toJSONSchema(t.TASK_RUN)));",
    ].join("\n");
    const { stdout } = await run(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: issueHost, maxBuffer: 1_048_576, signal: context.signal },
    );
    assert.deepEqual(JSON.parse(stdout), z.toJSONSchema(taskRunSchema));
  },
);

test(
  "a task run shows its outcome once ended, and is running only while its process runs",
  options,
  async (context) => {
    const runs = await runsFolder(context);
    const bin = join(dirname(runs), "bin");
    const live = await nodeProcess(bin, "live.mjs");
    context.after(() => live.kill());
    const gone = await nodeProcess(bin, "gone.mjs");
    gone.kill();
    await once(gone, "exit");
    const ids = {
      ended: randomUUID(),
      running: randomUUID(),
      crashed: randomUUID(),
      reused: randomUUID(),
      elsewhere: randomUUID(),
    };
    const here = hostname();
    await writeRecord(
      taskRunPath(runs, issue, ids.ended),
      taskRun(ids.ended, issue, {
        state: "ended",
        step: "work",
        outcome: "failed",
        reason: "the model went away",
        endedAt: new Date().toISOString(),
      }),
    );
    await writeRecord(
      taskRunPath(runs, issue, ids.running),
      taskRun(ids.running, issue, { process: { pid: live.pid, host: here } }),
    );
    await writeRecord(
      taskRunPath(runs, issue, ids.crashed),
      taskRun(ids.crashed, issue, { process: { pid: gone.pid, host: here } }),
    );
    await writeRecord(
      taskRunPath(runs, issue, ids.reused),
      taskRun(ids.reused, issue, {
        process: { pid: live.pid, host: here },
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeRecord(
      taskRunPath(runs, issue, ids.elsewhere),
      taskRun(ids.elsewhere, issue, {
        process: { pid: live.pid, host: "fixture-elsewhere" },
      }),
    );
    const taskRuns = await loadTaskRuns(runs, [repo]);
    const seen = new Map(taskRuns.runs.map((item) => [item.record.id, item]));
    assert.equal(seen.get(ids.ended)?.state, "failed");
    assert.equal(seen.get(ids.ended)?.reason, "the model went away");
    assert.equal(seen.get(ids.running)?.state, "running");
    assert.equal(seen.get(ids.crashed)?.state, "unavailable");
    assert.match(seen.get(ids.crashed)?.reason ?? "", notRunning);
    assert.equal(seen.get(ids.reused)?.state, "unavailable");
    assert.match(seen.get(ids.reused)?.reason ?? "", pidReused);
    assert.equal(seen.get(ids.elsewhere)?.state, "unavailable");
    assert.match(seen.get(ids.elsewhere)?.reason ?? "", otherHost);
    assert.deepEqual(taskRuns.problems, []);
  },
);

test(
  "a task run's sessions are its transcripts beside the record",
  options,
  async (context) => {
    const runs = await runsFolder(context);
    const id = randomUUID();
    const path = taskRunPath(runs, issue, id);
    const folder = join(dirname(path), "sessions");
    await writeRecord(path, taskRun(id, issue));
    await writeText(join(folder, "work-1.jsonl"), "");
    await writeText(join(folder, "work-1.schema.json"), "{}");
    await writeText(join(dirname(runs), "outside.jsonl"), "");
    await symlink(
      join(dirname(runs), "outside.jsonl"),
      join(folder, "linked.jsonl"),
    );
    const [found] = (await loadTaskRuns(runs, [repo])).runs;
    assert.deepEqual(found?.sessions, [
      { key: "work-1", transcript: join(folder, "work-1.jsonl") },
    ]);
  },
);

test(
  "unreadable, malformed and misplaced records are problems, never runs",
  options,
  async (context) => {
    const runs = await runsFolder(context);
    const paths = {
      malformed: taskRunPath(runs, issue, randomUUID()),
      invalid: taskRunPath(runs, issue, randomUUID()),
      wrongFolder: taskRunPath(runs, issue, randomUUID()),
      wrongIssue: taskRunPath(runs, issue + 1, randomUUID()),
      oversized: taskRunPath(runs, issue, randomUUID()),
      linked: taskRunPath(runs, issue, randomUUID()),
    };
    const outside = join(dirname(runs), "outside.json");
    function idOf(path: string): string {
      return dirname(path).split("/").at(-1) ?? "";
    }
    await Promise.all([
      writeText(paths.malformed, '{"kind":"task-run",'),
      writeRecord(paths.invalid, {
        ...taskRun(idOf(paths.invalid), issue),
        state: "waiting",
      }),
      writeRecord(paths.wrongFolder, taskRun(randomUUID(), issue)),
      writeRecord(paths.wrongIssue, taskRun(idOf(paths.wrongIssue), issue)),
      writeText(paths.oversized, " ".repeat(oversizedBytes)),
      writeRecord(outside, taskRun(idOf(paths.linked), issue)),
      mkdir(dirname(paths.linked), { recursive: true }),
    ]);
    await symlink(outside, paths.linked);
    const taskRuns = await loadTaskRuns(runs, [repo]);
    assert.deepEqual(taskRuns.runs, []);
    assert.equal(taskRuns.problems.length, Object.keys(paths).length);
    assert.match(problem(taskRuns, paths.malformed), notRecord);
    assert.match(problem(taskRuns, paths.invalid), notRecord);
    assert.match(problem(taskRuns, paths.wrongIssue), misplaced);
    assert.equal(
      problem(taskRuns, paths.oversized),
      "exceeds the 1048576-byte read bound",
    );
    assert.equal(problem(taskRuns, paths.linked), "not a regular file");
    assert.ok(problem(taskRuns, paths.wrongFolder).includes("under"));
  },
);
