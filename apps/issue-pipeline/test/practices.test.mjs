// @ts-check
// The spec writer, the code writers and the first reviewers read the configured
// coding practices in full (config `practices`), and the config refuses entries
// outside the worktree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { OpsError } from "../src/process.ts";
import { practicesNote } from "../src/workflow/practices.ts";
import { next as nextFix } from "../src/workflow/stages/fix.ts";
import { next as nextImplement } from "../src/workflow/stages/implement.ts";
import { next as nextReview } from "../src/workflow/stages/review.ts";
import { next as nextSpec } from "../src/workflow/stages/spec.ts";
import { BUILD_CTX, buildState } from "./workflow-build-test-kit.mjs";
import {
  CFG,
  CTX,
  ITEM,
  openFinding,
  opReply,
  stateWith,
} from "./workflow-review-test-kit.mjs";

/** @import { StageMachine } from "../src/workflow/stages/types.ts" */

// The first review launches one session per lens.
const FIRST_REVIEW_LENSES = 3;
// A practices entry that isn't a path.
const NOT_A_PATH = 3;

test("the note names every practices file under the worktree", () => {
  const practices = ["CONTRIBUTING.md", "wiki/Decisions.md"];
  const note = practicesNote({ practices }, ITEM);
  for (const file of practices) {
    assert.ok(note.includes(path.join(ITEM.paths.worktree, file)), file);
  }
});

// The task of the session a stage machine launches first.
/** @param {StageMachine["next"]} next @param {string} stage @returns {string} */
function stageTask(next, stage) {
  const step = next(buildState(stage), BUILD_CTX, []);
  if (step.done) {
    throw new Error(`${stage} launched nothing`);
  }
  const [launch] = step.launches;
  if (launch.kind !== "child") {
    throw new Error(`${stage} launched ${launch.op} first, not a session`);
  }
  return launch.task;
}

test("the spec and implement sessions' tasks carry the note", () => {
  const state = buildState("spec");
  const { cfg } = BUILD_CTX;
  assert.ok(
    stageTask(nextSpec, "spec").includes(practicesNote(cfg, state, "spec")),
  );
  assert.ok(
    stageTask(nextImplement, "implement").includes(
      practicesNote(cfg, state, "writer"),
    ),
  );
});

test("the first-review tasks carry the reviewer's note", () => {
  const begun = nextReview(stateWith("review"), CTX, []);
  const prepared = {
    ok: true,
    headSha: "ccccccc",
    diffPath: "/d.diff",
    diffLines: 1,
  };
  const step = nextReview(begun.state, CTX, [opReply(prepared)]);
  assert.ok(!step.done);
  assert.equal(step.launches.length, FIRST_REVIEW_LENSES);
  for (const launch of step.launches) {
    assert.ok(launch.kind === "child", launch.name);
    assert.ok(
      launch.task.includes(practicesNote(CFG, ITEM, "reviewer")),
      launch.name,
    );
  }
});

test("the fix task carries the writer's note", () => {
  const given = stateWith("fix", {
    findings: [openFinding("f1", ["correctness"])],
  });
  const step = nextFix(given, CTX, []);
  assert.ok(!step.done);
  const [launch] = step.launches;
  assert.equal(launch.name, "fix-r1");
  assert.ok(launch.kind === "child", launch.name);
  assert.ok(launch.task.includes(practicesNote(CFG, ITEM, "writer")));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-practices-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
// A config file with the required fields and `extra`.
/** @param {object} extra @returns {string} */
function configWith(extra) {
  const file = path.join(tmp, `${Math.random()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo: "o/r",
      account: "a",
      allowedUsers: ["a"],
      commands: { test: "true" },
      ...extra,
    }),
  );
  return file;
}

test("practices default to AGENTS.md and CONTRIBUTING.md", () => {
  assert.deepEqual(loadConfig(configWith({})).practices, [
    "AGENTS.md",
    "CONTRIBUTING.md",
  ]);
});

test("practices entries must stay inside the worktree", () => {
  for (const bad of [
    "/etc/passwd",
    "../x.md",
    "wiki/../../x.md",
    "",
    NOT_A_PATH,
  ]) {
    assert.throws(
      () => loadConfig(configWith({ practices: [bad] })),
      OpsError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => loadConfig(configWith({ practices: "CONTRIBUTING.md" })),
    OpsError,
  );
});
