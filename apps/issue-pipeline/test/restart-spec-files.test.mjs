// @ts-check
// A restart's check of the test and stub files its spec documents
// (src/spec-files.ts, src/restart-spec.ts): the files the spec's Tests
// section and Files list name that the branch lacks stop the issue when the
// spec writer wrote them, and otherwise go to the implementer, noted in the
// issue's log.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setEnv } from "./ops-run-test-kit.mjs";
import { claimAt } from "./workflow-stages-fixtures.mjs";

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { documentedFiles, missingSpecFiles } = await import(
  "../src/spec-files.ts"
);
const { checkedSpecFiles, specFilesMissing } = await import(
  "../src/restart-spec.ts"
);
const { claimStep } = await import("../src/workflow/stages/entry.ts");

const SPEC = [
  "## Behaviour",
  "",
  "1. `src/not-a-test.ts:12` does the thing.",
  "",
  "## Tests",
  "",
  "- `test/thing.test.mjs`: the thing, at `test/thing-kit.mjs:4-9`.",
  "- `node --test` runs them; `apps/x` is a folder.",
  "",
  "## Out of scope",
  "",
  "- `test/later.test.mjs`.",
].join("\n");
const FILES = ["src/thing.ts", "src/old/**", "docs/"];
const ISSUE = 7;
const NOW = new Date("2026-10-16T20:00:00Z");
const MISSING = ["test/thing-kit.mjs", "src/thing.ts"];
const WIKI_DIR = "wiki";

test("the documented files are the Tests section's paths and the listed non-glob files", () => {
  assert.deepEqual(documentedFiles(SPEC, FILES, WIKI_DIR), [
    "test/thing.test.mjs",
    "test/thing-kit.mjs",
    "src/thing.ts",
  ]);
});

test("the missing files are those the branch lacks, by path or app-relative path", () => {
  const tracked = ["apps/issue-pipeline/test/thing.test.mjs", "README.md"];
  assert.deepEqual(missingSpecFiles(SPEC, FILES, tracked, WIKI_DIR), MISSING);
});

/**
 * A git checkout at `name` whose one commit holds `files`, each empty.
 * @param {string} name
 * @param {readonly string[]} files
 * @returns {string}
 */
function committed(name, files) {
  const wt = path.join(d, name);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), "");
  }
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"],
  ]) {
    spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
  }
  return wt;
}

test("a branch's commit is checked for the documented files", () => {
  const wt = committed("wt", ["test/thing.test.mjs"]);
  const state = { stage: "review", spec: SPEC, files: FILES };
  assert.deepEqual(specFilesMissing(wt, state, WIKI_DIR), MISSING);
  const atSpec = { ...state, stage: "spec" };
  assert.deepEqual(specFilesMissing(wt, atSpec, WIKI_DIR), []);
});

test("a restart of a spec writer's spec that lists wiki pages is not stopped for them", () => {
  const wt = committed("wt-wiki", ["test/thing.test.mjs", ...MISSING]);
  const spec = SPEC.replace(
    "## Out of scope",
    "- `wiki/Tested.md`.\n\n## Out of scope",
  );
  const state = {
    stage: "implement",
    spec,
    files: [...FILES, "wiki/Page.md"],
    specWritesTests: true,
  };
  const missing = specFilesMissing(wt, state, WIKI_DIR);
  assert.deepEqual(missing, []);
  const { specMissing } = checkedSpecFiles(state, missing, NOW);
  const step = claimStep(ISSUE, { ...claimAt("implement"), specMissing });
  assert.equal(step.kind === "claimed" && step.stop, null);
});

test("missing files of a spec whose writer wrote its tests stop the restart", () => {
  const state = { stage: "implement", specWritesTests: true, log: [] };
  const checked = checkedSpecFiles(state, MISSING, NOW);
  assert.deepEqual(checked, { state, specMissing: MISSING });
  const step = claimStep(ISSUE, {
    ...claimAt("implement"),
    specMissing: checked.specMissing,
  });
  assert.equal(step.kind, "claimed");
  assert.deepEqual(step.kind === "claimed" && step.stop, {
    reason:
      "the spec's documented tests or stubs are missing from the branch: `test/thing-kit.mjs`, `src/thing.ts`",
    detail:
      "The spec writer is responsible for the spec's tests and stubs. Add them to the branch, then remove the stop label to resume.",
    code: "spec-files",
  });
});

test("missing files of any other spec go to the implementer, noted in the log", () => {
  for (const specWritesTests of [false, undefined]) {
    const state = { stage: "implement", specWritesTests, log: ["a"] };
    const checked = checkedSpecFiles(state, MISSING, NOW);
    assert.deepEqual(checked.specMissing, []);
    const { unwrittenFiles, log } = checked.state;
    assert.deepEqual(unwrittenFiles, MISSING);
    assert.deepEqual(log, [
      "a",
      "2026-10-16T20:00Z restart: the spec documents files the branch lacks, left to the implementer: `test/thing-kit.mjs`, `src/thing.ts`",
    ]);
  }
});

test("a restart with every documented file present clears the old unwritten files", () => {
  const state = { stage: "review", unwrittenFiles: MISSING };
  assert.deepEqual(checkedSpecFiles(state, [], NOW), {
    state: { stage: "review" },
    specMissing: [],
  });
});

test("a claim with no missing files gives no stop", () => {
  const step = claimStep(ISSUE, { ...claimAt("implement"), specMissing: [] });
  assert.equal(step.kind === "claimed" && step.stop, null);
});
