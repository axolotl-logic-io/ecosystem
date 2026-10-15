// workflow.js is the body of an async function that pi-subagents runs with
// `args` and its tools in scope, so `node --check` can't parse it. Compile it
// the same way, without running it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("workflow.js compiles as an async function body", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = fs.readFileSync(new URL("../workflow.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new AsyncFunction("args", body));
});
