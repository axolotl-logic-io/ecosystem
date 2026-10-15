// workflow.js is the body of an async function that pi-subagents runs with
// `args` and its tools in scope, so `node --check` can't parse it. Compile it
// the same way, without running it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("workflow.js compiles as an async function body", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new AsyncFunction("args", body));
});

// The merge summary's Acceptance line, lifted from workflow.js with `cfg` in scope.
const wf = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
const acceptanceSummary = new Function("cfg", wf.match(/function acceptanceSummary\([\s\S]*?\n\}\n/)[0] + "return acceptanceSummary;")({ baseBranch: "integration" });

test("the Acceptance line comes from the state, so a merge in a later sweep keeps it", () => {
  assert.equal(acceptanceSummary({ st: { acceptReason: "Does what #7 asks." } }), "Does what #7 asks.");
});

test("the Acceptance line notes a verdict given before a clean rebase", () => {
  assert.equal(
    acceptanceSummary({ st: { acceptReason: "Does what #7 asks." }, rebasedOnly: true }),
    "Does what #7 asks. (passed before a clean rebase onto integration)",
  );
  assert.equal(acceptanceSummary({ st: {}, rebasedOnly: true }), "passed before a clean rebase onto integration");
  assert.equal(acceptanceSummary({ st: {} }), "");
});
