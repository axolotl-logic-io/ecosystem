// workflow.js is the body of an async function that pi-subagents runs with
// `args` and its tools in scope, so `node --check` can't parse it. Compile it
// the same way, without running it. Its helpers live in src/workflow/, and it
// reads them from one destructure of `workflowModules.helpers`.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { helpers } from "../src/workflow/index.ts";
import { acceptanceSummary } from "../src/workflow/summary.ts";

// The destructure of the helpers' bundle in workflow.js.
const HELPERS_DESTRUCTURE =
  /const \{(?<list>[^}]*)\} = workflowModules\.helpers;/u;
// One destructured name, with or without a local rename.
const DESTRUCTURED_NAME = /^\s*(?<name>\w+)\s*(?::\s*\w+\s*)?$/u;
// The loop, a function declaration and a labelled section of the old body.
const WHILE_LOOP = /\bwhile\s*\(/gu;
const FUNCTION_DECLARATION = /\bfunction\b/u;
const SECTION_BLOCK = /\/\/ -{10}/u;

const body = fs.readFileSync(
  new URL("../src/workflow.js", import.meta.url),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async () => null).constructor;
const cfg = { baseBranch: "integration" };

// The names workflow.js destructures from the helpers, before any rename; an
// entry that isn't a plain name reads as "".
function destructuredNames(source) {
  const list = HELPERS_DESTRUCTURE.exec(source)?.groups?.list ?? "";
  return list
    .split(",")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => DESTRUCTURED_NAME.exec(entry)?.groups?.name ?? "");
}

test("workflow.js compiles as an async function body", () => {
  assert.doesNotThrow(() => new AsyncFunction("args", body));
});

test("every helper workflow.js reads is one the helpers' module exports", () => {
  const names = destructuredNames(body);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(Object.hasOwn(helpers, name), name);
    assert.notEqual(helpers[name], undefined, name);
  }
});

test("workflow.js is only the top-level loop", () => {
  assert.equal(body.match(WHILE_LOOP)?.length, 1);
  assert.doesNotMatch(body, FUNCTION_DECLARATION);
  assert.doesNotMatch(body, SECTION_BLOCK);
});

test("workflow.js reads every helper the helpers' module lists", () => {
  const read = new Set(destructuredNames(body));
  assert.deepEqual(read, new Set(Object.keys(helpers)));
});

test("the Acceptance line comes from the state, so a merge in a later sweep keeps it", () => {
  assert.equal(
    acceptanceSummary(cfg, { st: { acceptReason: "Does what #7 asks." } }),
    "Does what #7 asks.",
  );
});

test("the Acceptance line notes a verdict given before a clean rebase", () => {
  assert.equal(
    acceptanceSummary(cfg, {
      st: { acceptReason: "Does what #7 asks." },
      rebasedOnly: true,
    }),
    "Does what #7 asks. (passed before a clean rebase onto integration)",
  );
  assert.equal(
    acceptanceSummary(cfg, { st: {}, rebasedOnly: true }),
    "passed before a clean rebase onto integration",
  );
  assert.equal(acceptanceSummary(cfg, { st: {} }), "");
});
