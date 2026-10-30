// `buddy --check` on a launcher buddy file, through the real entrypoint
// `src/buddy.ts`, as the operator runs it before starting a buddy.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  BUDDIES,
  machine,
  REPO,
} from "../../support/task-app/task-app-test-kit.ts";

const CHECKED = z.strictObject({
  buddy: z.string(),
  account: z.string(),
  tasks: z.array(z.string()),
  repositories: z.array(
    z.strictObject({ config: z.string(), repo: z.string(), base: z.string() }),
  ),
  apps: z.record(z.string(), z.string()),
});
const NO_APP = /task implement has no installed task app/u;
const NOT_A_TASK = /tasks/u;

test("buddy --check accepts a launcher buddy and names each task's app", () => {
  const box = machine();
  try {
    box.install("gherkin");
    box.install("implement");
    const checked = box.check("hippy", ["gherkin", "implement"]);
    assert.equal(checked.status, 0, checked.stderr);
    const summary = CHECKED.parse(JSON.parse(checked.stdout));
    assert.equal(summary.account, BUDDIES.hippy);
    assert.deepEqual(summary.tasks, ["gherkin", "implement"]);
    assert.deepEqual(
      summary.repositories.map(({ repo, base }) => ({ repo, base })),
      [{ repo: REPO, base: "main" }],
    );
    assert.deepEqual(summary.apps, {
      gherkin: path.join(box.pipeline, "gherkin.mjs"),
      implement: path.join(box.pipeline, "implement.mjs"),
    });
  } finally {
    box.cleanup();
  }
});

test("buddy --check refuses a task whose app isn't installed", () => {
  const box = machine();
  try {
    box.install("gherkin");
    const checked = box.check("hippy", ["gherkin", "implement"]);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, NO_APP);
  } finally {
    box.cleanup();
  }
});

test("buddy --check refuses a task that no start label starts", () => {
  const box = machine();
  try {
    box.install("refactor-safely");
    const checked = box.check("hippy", ["refactor-safely"]);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, NOT_A_TASK);
  } finally {
    box.cleanup();
  }
});
