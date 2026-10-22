// The stage job's pi extension: the --output-schema flag it registers, and
// the terminating structured_output tool it gives a session, whose result
// details are the arguments the model passed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import structuredOutput from "../../src/job/structured-output.ts";

/** @typedef {Parameters<typeof structuredOutput>[0]} ExtensionApi */
/** @typedef {Parameters<ExtensionApi["registerTool"]>[0]} OutputTool */
/** @typedef {{ name: string, options: Parameters<ExtensionApi["registerFlag"]>[1] }} Flag */
/** @typedef {{ flags: Flag[], events: string[], tools: OutputTool[] }} Loaded */

const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string" } },
  required: ["decision"],
};

// Loads the extension into a fake pi whose --output-schema flag is `flag`,
// starts the session, and returns what the extension registered.
/** @param {string | undefined} flag @returns {Loaded} */
function load(flag) {
  /** @type {Loaded} */
  const loaded = { flags: [], events: [], tools: [] };
  /** @type {(() => void)[]} */
  const handlers = [];
  const flags = new Map([["output-schema", flag]]);
  structuredOutput({
    registerFlag: (name, options) => loaded.flags.push({ name, options }),
    getFlag: (name) => flags.get(name),
    registerTool: (tool) => loaded.tools.push(tool),
    on: (event, handler) => {
      loaded.events.push(event);
      handlers.push(handler);
    },
  });
  for (const handler of handlers) {
    handler();
  }
  return loaded;
}

/** @param {string} content @returns {string} */
function schemaFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-output-schema-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "schema.json");
  fs.writeFileSync(file, content);
  return file;
}

test("the output tool takes the schema file's JSON Schema as its parameters and ends the session with its arguments as details", async () => {
  const { tools } = load(schemaFile(JSON.stringify(SCHEMA)));
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.ok(tool);
  assert.equal(tool.name, "structured_output");
  assert.deepEqual(tool.parameters, SCHEMA);
  const args = { decision: "ready" };
  const result = await tool.execute("c1", args);
  assert.deepEqual(result.details, args);
  assert.equal(result.terminate, true);
});

test("the output extension registers no tool and fails the session when the flag names no JSON Schema", () => {
  const before = process.exitCode;
  try {
    for (const flag of [undefined, "", "/no/such/schema.json"]) {
      process.exitCode = 0;
      assert.deepEqual(load(flag).tools, []);
      assert.equal(process.exitCode, 1);
    }
    process.exitCode = 0;
    assert.deepEqual(load(schemaFile("[1, 2]")).tools, []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = before;
  }
});
