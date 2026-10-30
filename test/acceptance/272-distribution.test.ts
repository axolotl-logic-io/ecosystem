// Issue #272: a clean installed distribution runs all tasks through the launcher
// while keeping operator data separate from immutable installed assets.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TASK_RUN } from "../../apps/issue-host/src/task-app/run-record.ts";
import {
  applyStart,
  type BuddyChoice,
  HARDENING,
  ISSUE,
  machine,
  type PlannedSession,
} from "../../apps/issue-host/test/system/runtime/buddy-flow-test-kit.ts";

const END = /<!-- task-app:(?<task>[a-z]+):end /gu;
const TASK_COUNT = 5;
const WRITE: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted widgets." },
};

test("a clean installation runs all five tasks through the launcher with separate host data", async () => {
  const box = machine(
    (world) => {
      const issue = world.issues.find(({ number }) => number === ISSUE);
      assert.ok(issue !== undefined);
      issue.labels = [];
      world.collaborators = ["autumn", "lawd-landing"];
    },
    {
      landPermission: true,
      requireCi: true,
      separateData: true,
      throughLauncher: true,
    },
  );
  try {
    async function run(
      task: string,
      account: BuddyChoice["account"],
      sessions: PlannedSession[],
    ): Promise<void> {
      applyStart(box, `start:${task}`);
      const end = await box.runTaskApp(
        task,
        { account, tasks: [task] },
        sessions,
      );
      assert.equal(end.status, 0, end.stderr);
    }
    await run("gherkin", "hippy", [
      {
        ...WRITE,
        commit: null,
        reply: {
          outcome: "gherkin",
          gherkin: "Feature: Count widgets",
          assumptions: [],
        },
      },
    ]);
    await run("implement", "hippy", [WRITE, HARDENING]);
    await run("fix", "hippy", []);
    const head = box.git(["rev-parse", "agent/issue-7"]);
    box.change((state) => {
      state.checks = { [head]: [{ name: "check", bucket: "pass" }] };
    });
    await run("verify", "lawd", [
      {
        ...WRITE,
        commit: null,
        reply: { summary: "Reviewed widgets", findings: [] },
      },
    ]);
    await run("land", "lawd", []);
    const world = box.world();
    const issue = world.issues.find(({ number }) => number === ISSUE);
    assert.ok(issue !== undefined);
    assert.ok(issue.closed !== undefined);
    assert.equal(world.pulls?.[0]?.state, "MERGED");
    const completed = issue.comments.flatMap(({ body }) =>
      [...body.matchAll(END)].map(({ groups }) => {
        const { task } = groups ?? {};
        return task;
      }),
    );
    assert.deepEqual(completed.sort(), [
      "fix",
      "gherkin",
      "implement",
      "land",
      "verify",
    ]);
    assert.equal(fs.existsSync(path.join(box.pipeline, "runs")), false);
    assert.equal(fs.existsSync(path.join(box.pipeline, "work")), false);
    const records = fs.globSync("data/runs/*/issue-7/task-runs/*/run.json", {
      cwd: box.root,
    });
    assert.equal(records.length, TASK_COUNT);
    for (const file of records) {
      const record = TASK_RUN.parse(
        JSON.parse(fs.readFileSync(path.join(box.root, file), "utf8")),
      );
      assert.equal(record.state, "ended");
      assert.equal(record.outcome, "succeeded");
    }
  } finally {
    box.cleanup();
  }
});
