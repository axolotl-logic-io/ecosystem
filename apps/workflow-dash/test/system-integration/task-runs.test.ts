// A task app's run, end to end: the sample task app on the task framework
// runs as a buddy launches it, against fake GitHub, and writes its run record.
// The collector runs as its own process and imports it into a disposable
// database, and the view and the task_runs tool read it back.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type DatabaseConnection, openDatabase } from "@ecosystem/db";
import { createTestDatabase, type TestDatabase } from "@ecosystem/db/testing";
import { z } from "zod";
import {
  apply,
  BUDDIES,
  ISSUE,
  type Machine,
  machine,
  REPO,
} from "../../../issue-host/test/support/task-app/task-app-test-kit.ts";
import { configure } from "../../config.ts";
import { MonitorRuntime } from "../../monitor/runtime.ts";
import { MonitorView, type MonitorViewOptions } from "../../monitor/view.ts";
import { readTools } from "../../tools.ts";
import { writeText } from "../support/task-run-fixtures.ts";

const run = promisify(execFile);
const collector = fileURLToPath(
  new URL("../../monitor/collect.ts", import.meta.url),
);
const width = 140;
const rows = 40;
const usage = { input: 100, output: 20, cacheRead: 40, cacheWrite: 10 };
const tokenTotal = 170;
const refusedConfiguration = /Monitoring configuration refused/u;
const toolOutput = z.object({
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
});
const taskRunsOutput = z.object({
  taskRuns: z.array(
    z.object({
      id: z.string(),
      task: z.string(),
      account: z.string(),
      step: z.string(),
      state: z.string(),
      reason: z.string().nullable(),
      tokens: z.number().nullable(),
      sessions: z.array(z.object({ key: z.string() })),
    }),
  ),
});

const at: TestDatabase = await createTestDatabase();
const root: string = await mkdtemp(join(tmpdir(), "workflow-dash-task-run-"));
const world: Machine = machine();
const config = join(root, "workflow-dash.json");
const credentials = join(root, "monitoring-writer.env");
await writeFile(config, JSON.stringify({ repos: [REPO], subagentRuns: root }));
await writeFile(credentials, `DATABASE_URL=${at.url}\n`, { mode: 0o600 });
const runtime = new MonitorRuntime(
  (): Promise<DatabaseConnection> => Promise.resolve(openDatabase(at.url)),
);
after(async (): Promise<void> => {
  await runtime.stop();
  world.cleanup();
  await at.close();
  await rm(root, { recursive: true, force: true });
});

/** Runs the collector once, as an operator starts it, on the machine's data root. */
async function collect(
  settings: string = config,
  dataRoot: string = world.pipeline,
): Promise<void> {
  await run(
    process.execPath,
    [collector, "--once", "--config", settings, "--credentials", credentials],
    {
      // The fake gh comes first, so the collector never reaches GitHub.
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["PATH", `${world.bin}:${process.env.PATH ?? ""}`],
          ["ECOSYSTEM_DATA_ROOT", dataRoot],
        ]),
      },
      timeout: 60_000,
    },
  );
}
function taskRunsFolder(): string {
  return join(
    world.pipeline,
    "runs",
    REPO.replace("/", "__"),
    `issue-${ISSUE}`,
    "task-runs",
  );
}
function plain(_color: string, value: string): string {
  return value;
}
/** The view's lines, as wide as the screen. */
function view(): string[] {
  const options: MonitorViewOptions = {
    runtime,
    repositories: [REPO],
    done: (): void => undefined,
    theme: {
      fg: plain,
      bg: plain,
      bold: (value: string): string => value,
      style: (value: string): string => value,
      colors: new Proxy<MonitorViewOptions["theme"]["colors"]>(
        Object.create(null),
        {
          get: (): { kind: "rgb"; r: number; g: number; b: number } => ({
            kind: "rgb",
            r: 0,
            g: 0,
            b: 0,
          }),
        },
      ),
    },
  };
  return new MonitorView(
    { terminal: { rows }, requestRender: (): void => undefined },
    options,
  ).render(width);
}
function text(): string {
  return view().join("\n");
}
async function taskRuns(): Promise<z.infer<typeof taskRunsOutput>["taskRuns"]> {
  const [tool] = readTools({ active: (): boolean => true, runtime });
  if (tool === undefined) {
    throw new Error("the task_runs tool is not registered");
  }
  const result = toolOutput.parse(await tool.execute("call", { repo: REPO }));
  return taskRunsOutput.parse(JSON.parse(result.content[0].text)).taskRuns;
}

await runtime.start(configure({ repos: [REPO] }));

test("a running task app's run is active, then shows its outcome once it ends", async (): Promise<void> => {
  const app = world.run("hippy", { gate: true });
  app.ready();
  const [id] = await readdir(taskRunsFolder());
  assert.ok(id);
  // A model session's transcript, as the task app's sessions write it.
  await writeText(
    join(taskRunsFolder(), id, "sessions", "work-1.jsonl"),
    `${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "A reply", usage },
    })}\n`,
  );
  await collect();
  await runtime.refresh();
  assert.ok(view().every((line): boolean => visibleWidth(line) <= width));
  const running = text();
  assert.ok(running.includes("ACTIVE · 1"), running);
  assert.ok(running.includes(`${BUDDIES.hippy} · gherkin › work`), running);
  const [live] = await taskRuns();
  assert.equal(live?.id, id);
  assert.equal(live?.state, "running");
  assert.equal(live?.step, "work");
  assert.equal(live?.account, BUDDIES.hippy);
  assert.equal(live?.tokens, tokenTotal);
  assert.deepEqual(
    live?.sessions.map((session) => session.key),
    ["work-1"],
  );

  app.release();
  assert.equal((await app.exited).status, 0);
  await collect();
  await runtime.refresh();
  const [ended] = await taskRuns();
  assert.equal(ended?.state, "succeeded");
  assert.equal(ended?.step, "unmark");
  assert.ok(text().includes("gherkin succeeded"));
});

test("a failed task run needs you, with its reason", async (): Promise<void> => {
  world.change((state): void => apply(state, "start:gherkin"));
  const ended = await world.runToEnd("hippy", { fail: "the sample broke" });
  assert.equal(ended.status, 1);
  await collect();
  await runtime.refresh();
  const [failed] = await taskRuns();
  assert.equal(failed?.state, "failed");
  assert.ok(failed?.reason?.includes("the sample broke"));
  const screen = text();
  assert.ok(screen.includes("NEEDS YOU · 1"), screen);
  assert.ok(screen.includes("gherkin failed"), screen);
  assert.ok(screen.includes("the sample broke"), screen);
});

test("the collector refuses unknown settings and a missing data root", async (): Promise<void> => {
  const unknown = join(root, "unknown.json");
  await writeFile(unknown, JSON.stringify({ repos: [REPO], extra: true }));
  await assert.rejects(collect(unknown), (error: unknown): boolean => {
    const { code, stderr } = z
      .object({ code: z.number(), stderr: z.string() })
      .parse(error);
    return code === 1 && refusedConfiguration.test(stderr);
  });
  await assert.rejects(
    collect(config, "relative/data"),
    (error: unknown): boolean =>
      refusedConfiguration.test(
        z.object({ stderr: z.string() }).parse(error).stderr,
      ),
  );
});
