import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBuddyRuns } from "../buddy-runs.ts";
import { observedAccount } from "../buddy-source.ts";
import { configure } from "../config.ts";
import { taskCoverage } from "../language.ts";
import {
  observedCapacity,
  processObservation,
  runCondition,
} from "../observations.ts";
import { live, pidWorkflowRun } from "../process-observations.ts";
import type { WorkflowRun } from "../workflow-source.ts";

const notObserved = /not observed/u;
const unverified = /unverified/u;

function runFixture(observation: boolean | null): WorkflowRun {
  return {
    repo: "org/repo",
    issue: 1,
    dir: "/nonexistent/workflow-dash-domain",
    live: observation,
    records: [],
    data: { stage: "merge", launches: [], outcome: null },
  };
}

test("buddy configuration accepts both older names with canonical string precedence", (): void => {
  const config = configure({
    buddyRuns: "~/buddy",
    agentRuns: "~/agent",
    operators: "~/operator",
  });
  assert.equal(config.buddyRuns, join(homedir(), "buddy"));
  assert.equal(
    configure({ buddyRuns: false, agentRuns: "~/agent" }).buddyRuns,
    join(homedir(), "agent"),
  );
  assert.equal(
    configure({ agentRuns: "~/agent", operators: "~/operator" }).buddyRuns,
    join(homedir(), "agent"),
  );
  assert.equal(
    configure({ operators: "~/operator" }).buddyRuns,
    join(homedir(), "operator"),
  );
  assert.equal(Object.hasOwn(config, "agentRuns"), false);
  assert.equal(Object.hasOwn(config, "operators"), false);
});

test("legacy delivery coverage never fabricates a current task or a passing result", (): void => {
  assert.deepEqual(taskCoverage("merge").tasks, [
    "Sync",
    "Integration",
    "Security",
    "Land",
    "Completion",
  ]);
  assert.equal(taskCoverage("merge").currentTask, null);
  assert.match(taskCoverage("merge").evidence, notObserved);
  assert.deepEqual(taskCoverage("unknown-upstream-task").tasks, []);
  assert.equal(Object.hasOwn(taskCoverage("merge"), "result"), false);
});

test("account observations validate metadata without inferring a buddy from its task", (): void => {
  assert.equal(observedAccount("axolotl-logic-hippy"), "axolotl-logic-hippy");
  assert.equal(
    observedAccount({ provider: "github", login: "axolotl-logic-lawd" }),
    "github:axolotl-logic-lawd",
  );
  assert.equal(observedAccount(undefined), null);
  assert.equal(observedAccount({ task: "Security", role: "Gatekeeper" }), null);
  assert.equal(observedAccount("\ninvalid"), null);
});

test("buddy loader shows explicitly recorded accounts and leaves missing accounts unknown", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "dash-buddy-source-"));
  try {
    await mkdir(join(root, "with-account"));
    await mkdir(join(root, "without-account"));
    const status = {
      state: "complete",
      startedAt: "2000-01-01T00:00:00Z",
      task: "fixture work",
    };
    await writeFile(
      join(root, "with-account/status.json"),
      JSON.stringify({ ...status, account: "fixture-account" }),
    );
    await writeFile(
      join(root, "without-account/status.json"),
      JSON.stringify(status),
    );
    const runs = await loadBuddyRuns(configure({ buddyRuns: root }), true);
    assert.equal(runs.length, 2);
    assert.equal(
      runs.find((run) => run.id === "with-account")?.account,
      "fixture-account",
    );
    assert.equal(
      runs.find((run) => run.id === "without-account")?.account,
      null,
    );
    assert.match(runs[0].accountSource, unverified);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown process observations cannot imply success, completion or available capacity", async (): Promise<void> => {
  const run = runFixture(null);
  assert.equal(processObservation(run), "unknown");
  assert.equal(runCondition(run), "? UNKNOWN");
  assert.equal(runCondition(runFixture(false)), "○ NOT OBSERVED");
  assert.deepEqual(observedCapacity([run, runFixture(true)]), {
    observedProcesses: 1,
    unknownProcesses: 1,
    configuredLimit: null,
    source:
      "Process observations only; leases, configured resource caps and releases are not collected.",
  });
  assert.equal(
    await live({ outcome: null, pid: 1 }, async (): Promise<null> => null),
    null,
  );
  assert.equal(await pidWorkflowRun(-1), null);
});
