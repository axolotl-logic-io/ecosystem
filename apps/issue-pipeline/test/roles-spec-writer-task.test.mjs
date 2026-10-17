// @ts-check
// The spec writer role's session and its task (#333, #335): the agent, the
// schema, model and budget; what the task asks the session to read and
// write; the split line by depth; a retry's check output; the spec draft it
// commits as it goes and its context limits; and the handoff it reads first,
// or a continuation leads with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { transition } from "../src/roles/spec-writer/machine.ts";
import { SPEC_WRITER_SCHEMA } from "../src/roles/spec-writer/reply.ts";
import { SPEC_DRAFT } from "../src/spec-draft.ts";
import { sessionBudget } from "../src/workflow/budget.ts";
import {
  COMMITTED,
  dataWith,
  PRACTICES,
  READINGS,
  retried,
  SPEC_SECTIONS,
  specContext,
  stepFrom,
} from "./spec-writer-role-test-kit.mjs";

const EACH_TEST_NAMES = /each test names the interface it drives/iu;
const BASE = "base-333";
const MERGES_INTO_BASE = /\bbase-333\b[^.\n]*\bnot\b[^.\n]*\bproduction\b/u;
const NEVER_RELEASES = /\breleasing\b[^.\n]*\bnever\b/iu;
const NOT_ALLOWED = /splitting is not allowed/u;
const AS_YOU_GO = /\bpipeline_commit\b[^\n]*\bas you go\b/u;
const READ_IT_FIRST = /\bread it first\b/iu;
const CONTINUES =
  /^A previous session ran out of room\. Read its handoff first: /u;
const FILES_FIELD = /`files`/u;
const DESIGN_ANCHORS =
  "- **Design**: the approach, with `file:line` anchors to the code it builds on,";

/** @returns {string} the task of a continuation, after a handoff */
function continuedTask() {
  const { effect } = stepFrom(
    "resume",
    "ok",
    { committed: COMMITTED },
    { reply: READINGS.handoff, attempts: 1 },
  );
  if (effect.kind !== "session") {
    throw new Error(`a resume ran ${effect.kind}, not a session`);
  }
  return effect.task;
}

/** @param {string} task @param {string} file @returns {string[]} the task's lines that name `file` */
function linesNaming(task, file) {
  return task.split("\n").filter((line) => line.includes(file));
}

test("the session is the specifier's, with the role's schema, model and budget", () => {
  const { settings } = dataWith();
  const session = retried({ attempts: 1 });
  assert.equal(session.name, "spec");
  assert.equal(session.agent, "issue-pipeline-specifier");
  assert.equal(session.model, settings.models.spec);
  assert.equal(session.schema, SPEC_WRITER_SCHEMA);
  assert.equal(session.budgetRole, "spec");
  assert.equal(session.tokenBudget, sessionBudget(settings.budgets, "spec"));
  assert.equal(session.attempt, 2);
});

test("the task names the practices files, every section, the fields, the commit tool and the base", () => {
  const { settings } = dataWith();
  const cfg = { ...settings.cfg, baseBranch: BASE };
  const { task } = retried({ settings: { ...settings, cfg } });
  const { worktree } = settings.paths;
  for (const file of PRACTICES) {
    assert.ok(task.includes(`${worktree}/${file}`), file);
  }
  for (const section of SPEC_SECTIONS) {
    assert.ok(task.includes(`**${section}**`), section);
  }
  for (const word of ["`interfaces`", "`noTestsReason`", "`pipeline_commit`"]) {
    assert.ok(task.includes(word), word);
  }
  assert.match(task, EACH_TEST_NAMES);
  assert.match(task, MERGES_INTO_BASE);
  assert.match(task, NEVER_RELEASES);
});

// A spec names only its entry points, in its interfaces (#388, #391).
test("the task asks for no file list, anchors Design to the code, and asks for wikiOnly", () => {
  for (const depth of [0, 1]) {
    const { task } = retried({ depth });
    assert.doesNotMatch(task, FILES_FIELD);
    assert.ok(task.includes(DESIGN_ANCHORS), task);
    assert.ok(task.includes("`wikiOnly`"), task);
  }
});

test("split is offered only at depth 0, and a suggested split opens with triage's reason", () => {
  assert.doesNotMatch(retried().task, NOT_ALLOWED);
  assert.match(retried({ depth: 1 }).task, NOT_ALLOWED);
  const reason = "Three subsystems change.";
  const { task } = retried({ splitSuggested: reason });
  assert.ok(task.includes(reason));
  assert.equal(task.includes("Triage found this issue ready."), false);
});

test("a retry's task includes the failed check's output", () => {
  const failed = stepFrom("session", "failed", "lint: 3 errors in src/a.ts");
  const { effect } = transition(failed.state, { name: "ok", reply: null });
  assert.ok(effect.kind === "session");
  assert.ok(effect.task.includes("lint: 3 errors in src/a.ts"));
  assert.equal(retried().task.includes("lint: 3 errors"), false);
});

test("the task keeps the spec draft on the branch, commits as it goes, and states both context limits", () => {
  const { soft, hard } = specContext().cfg.contextLimits;
  for (const task of [retried().task, continuedTask()]) {
    assert.ok(task.includes(`\`${SPEC_DRAFT}\``), task);
    assert.ok(task.includes(`\`repo/${SPEC_DRAFT}\``), task);
    assert.match(task, AS_YOU_GO);
    assert.ok(task.includes(`at ${soft} tokens of context`), task);
    assert.ok(task.includes(`At ${hard} tokens of context`), task);
  }
});

test("a first session reads the handoff first if it exists, and a continuation leads with it instead", () => {
  const { handoffFile } = specContext().paths;
  const first = retried().task;
  const [named = ""] = linesNaming(first, handoffFile).filter((line) =>
    READ_IT_FIRST.test(line),
  );
  assert.ok(named.includes(`If ${handoffFile} exists`), first);
  assert.doesNotMatch(first, CONTINUES);
  const continued = continuedTask();
  assert.match(continued, CONTINUES);
  assert.ok(continued.includes(handoffFile), continued);
  assert.doesNotMatch(continued, READ_IT_FIRST);
  const [committedTest = ""] = COMMITTED.tests;
  assert.ok(continued.includes(`\`${committedTest}\``), continued);
});
