// The stage job's agent definitions: the pi command line each of the repo's
// definitions gives a session, and the failed launch a missing one gives.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

// The job reads definitions from $PI_CODING_AGENT_DIR, fixed when its
// modules load, so the variable is set before they are imported.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-agents-"));
process.on("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { parseDefinition, piArgs } = await import(
  "../src/job/agent-definition.ts"
);
const { runLaunch } = await import("../src/job/launch.ts");

// The four arguments that open and close every command line: the mode and
// model, and the extension and its schema.
const LEADING_FLAGS = 4;
const FRONTMATTER_FENCE = /^---/u;
const NOBODY = /issue-pipeline-nobody/u;

const FILES = {
  session: "/r/runs/o__r/issue-7/sessions/i7-spec-4.jsonl",
  extension: "/r/structured-output.mjs",
  schema: "/r/runs/o__r/issue-7/sessions/i7-spec-4.schema.json",
};

function specFor(agent) {
  return {
    key: "i7-spec-4",
    label: "Write the spec",
    agent,
    model: "anthropic/claude-opus-5-5",
    cwd: agentDir,
    task: "Write the spec.",
    outputSchema: { type: "object" },
    timeoutMs: 60_000,
    intercomBridge: { mode: "off" },
  };
}

function definitionOf(agent) {
  const file = new URL(`../agents/${agent}.md`, import.meta.url);
  return parseDefinition(fs.readFileSync(file, "utf8"));
}

function flagValue(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test("the reader runs pi in JSON mode with its tools, thinking and prompt", () => {
  const definition = definitionOf("issue-pipeline-reader");
  const args = piArgs(definition, specFor("issue-pipeline-reader"), FILES);
  assert.deepEqual(args.slice(0, LEADING_FLAGS), [
    "--mode",
    "json",
    "--model",
    "anthropic/claude-opus-5-5",
  ]);
  assert.equal(flagValue(args, "--thinking"), "high");
  assert.equal(
    flagValue(args, "--tools"),
    "read,grep,find,ls,codemode,structured_output",
  );
  assert.equal(flagValue(args, "--system-prompt"), definition.systemPrompt);
  assert.ok(definition.systemPrompt.length > 0);
  assert.doesNotMatch(definition.systemPrompt, FRONTMATTER_FENCE);
  assert.ok(args.includes("-ns"));
  assert.ok(!args.includes("-nc"));
  assert.equal(flagValue(args, "--session"), FILES.session);
  assert.deepEqual(args.slice(-LEADING_FLAGS), [
    "-e",
    FILES.extension,
    "--output-schema",
    FILES.schema,
  ]);
});

test("the specifier loads its subagent-only extension, without skills, with project context", () => {
  const definition = definitionOf("issue-pipeline-specifier");
  const args = piArgs(definition, specFor("issue-pipeline-specifier"), FILES);
  assert.equal(
    flagValue(args, "-e"),
    "{{PI_CODING_AGENT_DIR}}/npm/node_modules/pi-web-access",
  );
  assert.ok(
    flagValue(args, "--tools").startsWith("read,grep,find,ls,web_search"),
  );
  assert.ok(args.includes("-ns"));
  assert.ok(!args.includes("-nc"));
});

test("a definition without project context or a tools list runs with -nc and pi's default tools", () => {
  const definition = parseDefinition(
    "---\nname: x\ninheritProjectContext: false\ninheritSkills: true\n---\nBe brief.\n",
  );
  const args = piArgs(definition, specFor("x"), FILES);
  assert.ok(args.includes("-nc"));
  assert.ok(!args.includes("-ns"));
  assert.ok(!args.includes("--thinking"));
  assert.equal(flagValue(args, "--tools"), "+structured_output");
  assert.equal(flagValue(args, "--system-prompt"), "Be brief.");
});

test("a missing agent definition fails its launch with an error naming the agent", async () => {
  const sessions = path.join(agentDir, "sessions");
  const raw = await runLaunch(specFor("issue-pipeline-nobody"), (key) =>
    path.join(sessions, `${key}.jsonl`),
  );
  assert.equal(raw.ok, false);
  assert.equal(raw.structuredOutput, null);
  assert.match(raw.error, NOBODY);
  assert.equal(raw.key, "i7-spec-4");
});
