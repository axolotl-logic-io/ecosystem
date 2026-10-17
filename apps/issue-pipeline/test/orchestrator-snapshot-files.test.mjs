// @ts-check
// The orchestrator's file sets (#234): the files an issue's saved state
// names, or, when it names none, as a state restarted from the branch before
// restarts kept them, the files line spec's split wrote in its body. Only with
// neither does the issue claim the whole repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { filesLine } from "../src/workflow/files-line.ts";
import { NOW as SCHEDULE_NOW, SETTINGS } from "./orchestrator-fixtures.mjs";
import { cfg, NOW, openWith } from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");

const ISSUE = { pipeline: 2, web: 3, bare: 4, emptied: 5 };
const PIPELINE_FILES = ["apps/issue-pipeline/src/job/usage-log.ts"];
const WEB_FILES = ["apps/web/src/chats/**", "apps/web/drizzle/**"];
const SAVED_FILES = ["apps/web/src/saved.ts"];

// A sub-issue's body as the split op opens it: the part's body ending with its
// files line, then its parent and after marks.
/** @param {readonly string[]} files @returns {string} */
function subIssueBody(files) {
  return `Do the part.\n\nFiles: not this line\n\n${filesLine(files)}\n\nPart of #1.\n\n<!-- agent-pipeline:parent 1 depth 1 -->`;
}

/** @param {number} number @returns {readonly string[] | null | undefined} */
function filesOf(number) {
  const { issues } = readQueue(cfg, [], NOW);
  return issues.find((issue) => issue.number === number)?.files;
}

test("an issue whose saved state has no files takes them from its body's files line", () => {
  openWith([
    {
      number: ISSUE.pipeline,
      body: subIssueBody(PIPELINE_FILES),
      state: { stage: "checks", pr: 1 },
    },
  ]);
  assert.deepEqual(filesOf(ISSUE.pipeline), PIPELINE_FILES);
});

test("the saved state's files win over the body's", () => {
  openWith([
    {
      number: ISSUE.web,
      body: subIssueBody(WEB_FILES),
      state: { stage: "fix", files: SAVED_FILES },
    },
  ]);
  assert.deepEqual(filesOf(ISSUE.web), SAVED_FILES);
});

test("an empty files list in the saved state falls back on the body's", () => {
  openWith([
    {
      number: ISSUE.emptied,
      body: subIssueBody(WEB_FILES),
      state: { stage: "fix", files: [] },
    },
  ]);
  assert.deepEqual(filesOf(ISSUE.emptied), WEB_FILES);
});

test("with no files in the state or the body, the files are null (the whole repo)", () => {
  openWith([
    {
      number: ISSUE.bare,
      body: "No files line here.",
      state: { stage: "fix", files: null },
    },
  ]);
  assert.equal(filesOf(ISSUE.bare), null);
});

test("a fix in the web app isn't held by a pipeline change whose restarted state lost its files", () => {
  openWith([
    {
      number: ISSUE.pipeline,
      body: subIssueBody(PIPELINE_FILES),
      state: { stage: "checks", pr: 1 },
    },
    {
      number: ISSUE.web,
      body: subIssueBody(WEB_FILES),
      state: { stage: "fix", files: null, pr: 2 },
    },
  ]);
  const { issues } = readQueue(cfg, [], NOW);
  const snapshot = { issues, spentLastHour: 0 };
  const decided = schedule(snapshot, SETTINGS, SCHEDULE_NOW).map(
    ({ issue, action, reason }) => `#${issue} ${action} ${reason}`,
  );
  assert.ok(decided.includes(`#${ISSUE.web} started free`), String(decided));
});
