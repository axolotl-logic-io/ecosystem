// @ts-check
// workflow.js is the body of an async function that pi-subagents runs with
// `args` and its tools in scope, so `node --check` can't parse it. Compile it
// the same way, without running it. Its helpers live in src/workflow/, and it
// reads them from one destructure of `workflowModules.helpers`.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { helpers } from "../src/workflow/index.ts";
import { acceptanceSummary } from "../src/workflow/summary.ts";
import { buildState } from "./workflow-build-test-kit.mjs";

// The destructure of the helpers' bundle in workflow.js.
const HELPERS_DESTRUCTURE =
  /const \{(?<list>[^}]*)\} = workflowModules\.helpers;/u;
// One destructured name, with or without a local rename.
const DESTRUCTURED_NAME = /^\s*(?<name>\w+)\s*(?::\s*\w+\s*)?$/u;
// A loop, a function, an async function and a labelled section of the old
// body: the body has none of them. The helpers' driveBatches chains the
// batches.
const LOOP = /\b(?:while|for)\s*\(/u;
const FUNCTION_KEYWORD = /\bfunction\b/u;
const ASYNC_KEYWORD = /\basync\b/u;
// The one call that runs a batch of launches.
const RUNS_ALL_CALL = /\bruns\.all\(/gu;
// The driver's variable, whose summary build.ts's wrapper returns.
const SWEEP_DECLARATION = /\bconst sweep =/u;
const SECTION_BLOCK = /\/\/ -{10}/u;

const body = fs.readFileSync(
  new URL("../src/workflow.js", import.meta.url),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
const cfg = { baseBranch: "integration" };

// The names workflow.js destructures from the helpers, before any rename; an
// entry that isn't a plain name reads as "".
/** @param {string} source @returns {string[]} */
function destructuredNames(source) {
  const { list = "" } = HELPERS_DESTRUCTURE.exec(source)?.groups ?? {};
  return list
    .split(",")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const { name = "" } = DESTRUCTURED_NAME.exec(entry)?.groups ?? {};
      return name;
    });
}

test("workflow.js compiles as an async function body", () => {
  assert.doesNotThrow(() => new AsyncFunction("args", body));
});

test("every helper workflow.js reads is one the helpers' module exports", () => {
  const names = destructuredNames(body);
  const exported = new Map(Object.entries(helpers));
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(Object.hasOwn(helpers, name), name);
    assert.notEqual(exported.get(name), undefined, name);
  }
});

test("workflow.js only drives the batches, with no loop and no async", () => {
  assert.doesNotMatch(body, LOOP);
  assert.doesNotMatch(body, FUNCTION_KEYWORD);
  assert.doesNotMatch(body, ASYNC_KEYWORD);
  assert.equal(body.match(RUNS_ALL_CALL)?.length, 1);
  assert.match(body, SWEEP_DECLARATION);
  assert.doesNotMatch(body, SECTION_BLOCK);
});

test("workflow.js reads every helper the helpers' module lists", () => {
  const read = new Set(destructuredNames(body));
  assert.deepEqual(read, new Set(Object.keys(helpers)));
});

test("the Acceptance line comes from the state, so a merge in a later sweep keeps it", () => {
  assert.equal(
    acceptanceSummary(
      cfg,
      buildState("merge", { acceptReason: "Does what #7 asks." }),
    ),
    "Does what #7 asks.",
  );
});

test("the Acceptance line notes a verdict given before a clean rebase", () => {
  assert.equal(
    acceptanceSummary(cfg, {
      ...buildState("merge", { acceptReason: "Does what #7 asks." }),
      rebasedOnly: true,
    }),
    "Does what #7 asks. (passed before a clean rebase onto integration)",
  );
  assert.equal(
    acceptanceSummary(cfg, { ...buildState("merge"), rebasedOnly: true }),
    "passed before a clean rebase onto integration",
  );
  assert.equal(acceptanceSummary(cfg, buildState("merge")), "");
});
