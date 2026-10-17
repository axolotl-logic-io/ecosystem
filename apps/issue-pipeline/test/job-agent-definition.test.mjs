// The stage job's agent definitions: the pi command line each of the repo's
// definitions gives a session, and the failed launch a missing one gives.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

/** @import { AgentDefinition } from "../src/job/agent-definition.ts" */
/** @import { LaunchHooks } from "../src/job/launch.ts" */
/** @import { OpsRaw, SessionRaw } from "../src/job/raw-results.ts" */
/** @import { ChildSpec } from "../src/workflow/launches.ts" */

// The job reads definitions from $PI_CODING_AGENT_DIR, fixed when its
// modules load, so the variable is set before they are imported. Environment
// variables are named by strings, as install.test.mjs names them.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-agents-"));
process.on("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));
Object.assign(
  process.env,
  Object.fromEntries([["PI_CODING_AGENT_DIR", agentDir]]),
);
const { parseDefinition, piArgs } = await import(
  "../src/job/agent-definition.ts"
);
const { runLaunch } = await import("../src/job/launch.ts");

const FRONTMATTER_FENCE = /^---/u;
const NOBODY = /issue-pipeline-nobody/u;

// Launch hooks that put fresh sessions in `sessions` and record nothing.
/** @param {string} sessions @returns {LaunchHooks} */
function hooksIn(sessions) {
  return {
    sessionFile: (key) => path.join(sessions, `${key}.jsonl`),
    resumePoint: () => null,
    started: () => undefined,
    record: () => undefined,
    ended: () => undefined,
    contextLimits: { soft: 175_000, hard: 225_000 },
    handoffFile: path.join(sessions, "handoff.md"),
    contextStopped: () => undefined,
    sessionEnded: () => undefined,
    env: () => ({}),
    cwd: sessions,
    repo: sessions,
  };
}

const FILES = {
  session: "/r/runs/o__r/issue-7/sessions/i7-spec-4.jsonl",
  extension: "/r/structured-output.mjs",
  schema: "/r/runs/o__r/issue-7/sessions/i7-spec-4.schema.json",
  commit: null,
};
// A writer session's files, which load the pipeline_commit extension.
const WRITER_FILES = { ...FILES, commit: "/r/pipeline-commit.mjs" };

// A session's raw result, which a child launch always gives.
/** @param {OpsRaw | SessionRaw} raw @returns {SessionRaw} */
function sessionRawOf(raw) {
  if (!("key" in raw)) {
    throw new Error("a child launch gave an ops result");
  }
  return raw;
}

/** @param {string} agent @returns {ChildSpec} */
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
    budgetRole: "spec",
    tokenBudget: 80_000,
    intercomBridge: { mode: "off" },
  };
}

/** @param {string} agent @returns {AgentDefinition} */
function definitionOf(agent) {
  const file = new URL(`../agents/${agent}.md`, import.meta.url);
  return parsed(fs.readFileSync(file, "utf8"));
}

// The definition in `text`, which must parse.
/** @param {string} text @returns {AgentDefinition} */
function parsed(text) {
  const definition = parseDefinition(text);
  if (definition === null) {
    throw new Error("the agent definition didn't parse");
  }
  return definition;
}

// The value after `flag` in `args`, or "" when there is none.
/** @param {string[]} args @param {string} flag @returns {string} */
function flagValue(args, flag) {
  return args[args.indexOf(flag) + 1] ?? "";
}

// The values that follow each `flag` in `args`.
/** @param {string[]} args @param {string} flag @returns {string[]} */
function flagValues(args, flag) {
  return args.flatMap((arg, at) => {
    if (arg !== flag) {
      return [];
    }
    return [args[at + 1] ?? ""];
  });
}

// The value of `flag` in `args`, or null when `args` has no `flag`.
/** @param {string[]} args @param {string} flag @returns {string | null} */
function optionalFlag(args, flag) {
  if (!args.includes(flag)) {
    return null;
  }
  return flagValue(args, flag);
}

/**
 * What a pi command line sets for its session.
 * @typedef {{ mode: string | null, model: string | null, tools: string | null, thinking: string | null, systemPrompt: string | null, extensions: Set<string>, skills: boolean, projectContext: boolean, session: string | null, schema: string | null }} CommandLine
 */

// What `args` sets, read by flag rather than by position.
/** @param {string[]} args @returns {CommandLine} */
function commandLineOf(args) {
  return {
    mode: optionalFlag(args, "--mode"),
    model: optionalFlag(args, "--model"),
    tools: optionalFlag(args, "--tools"),
    thinking: optionalFlag(args, "--thinking"),
    systemPrompt: optionalFlag(args, "--system-prompt"),
    extensions: new Set(flagValues(args, "-e")),
    skills: !args.includes("-ns"),
    projectContext: !args.includes("-nc"),
    session: optionalFlag(args, "--session"),
    schema: optionalFlag(args, "--output-schema"),
  };
}

// What the job promises `definition` runs `spec` with: RPC mode with the
// spec's model, the definition's tools plus structured_output, its thinking,
// prompt, extensions and context settings, and the job's session file,
// output extension and schema.
/** @param {AgentDefinition} definition @param {ChildSpec} spec @returns {CommandLine} */
function promisedCommandLine(definition, spec) {
  return {
    mode: "rpc",
    model: spec.model,
    tools: [...definition.tools, "structured_output"].join(","),
    thinking: definition.thinking,
    systemPrompt: definition.systemPrompt,
    extensions: new Set([...definition.extensions, FILES.extension]),
    skills: definition.inheritSkills,
    projectContext: definition.inheritProjectContext,
    session: FILES.session,
    schema: FILES.schema,
  };
}

test("the reader runs pi in RPC mode as its definition says", () => {
  const definition = definitionOf("issue-pipeline-reader");
  const spec = specFor("issue-pipeline-reader");
  assert.deepEqual(
    commandLineOf(piArgs(definition, spec, FILES)),
    promisedCommandLine(definition, spec),
  );
  assert.ok(definition.systemPrompt.length > 0);
  assert.doesNotMatch(definition.systemPrompt, FRONTMATTER_FENCE);
});

test("the specifier runs pi in RPC mode as its definition says", () => {
  const definition = definitionOf("issue-pipeline-specifier");
  const spec = specFor("issue-pipeline-specifier");
  assert.deepEqual(
    commandLineOf(piArgs(definition, spec, FILES)),
    promisedCommandLine(definition, spec),
  );
});

// It writes its failing tests, their stubs and the wiki edits (#334).
test("the specifier may edit, write and run commands, and keeps the web tools", () => {
  const { tools } = definitionOf("issue-pipeline-specifier");
  for (const tool of ["edit", "write", "bash", "web_search"]) {
    assert.ok(tools.includes(tool), tool);
  }
});

test("a definition without project context or a tools list runs with -nc and pi's default tools", () => {
  const definition = parsed(
    "---\nname: x\ninheritProjectContext: false\ninheritSkills: true\n---\nBe brief.\n",
  );
  const args = piArgs(definition, specFor("x"), FILES);
  assert.ok(args.includes("-nc"));
  assert.ok(!args.includes("-ns"));
  assert.ok(!args.includes("--thinking"));
  assert.equal(flagValue(args, "--tools"), "+structured_output");
  assert.equal(flagValue(args, "--system-prompt"), "Be brief.");
});

test("a definition's thinking and extensions reach pi's command line", () => {
  const definition = parsed(
    "---\nname: x\ntools: read\nthinking: high\nsubagentOnlyExtensions: /x/ext-a, /x/ext-b\n---\nBe brief.\n",
  );
  const args = piArgs(definition, specFor("x"), FILES);
  assert.equal(flagValue(args, "--thinking"), "high");
  assert.deepEqual(
    new Set(flagValues(args, "-e")),
    new Set(["/x/ext-a", "/x/ext-b", FILES.extension]),
  );
  assert.equal(flagValue(args, "--tools"), "read,structured_output");
});

test("a writer session's files add the pipeline_commit extension and tool", () => {
  const definition = parsed("---\nname: x\ntools: read,edit\n---\nBe brief.\n");
  const args = piArgs(definition, specFor("x"), WRITER_FILES);
  assert.deepEqual(
    new Set(flagValues(args, "-e")),
    new Set([FILES.extension, WRITER_FILES.commit]),
  );
  assert.equal(
    flagValue(args, "--tools"),
    "read,edit,structured_output,pipeline_commit",
  );
});

test("a writer session with pi's default tools adds both tools to them", () => {
  const definition = parsed("---\nname: x\n---\nBe brief.\n");
  const args = piArgs(definition, specFor("x"), WRITER_FILES);
  assert.equal(
    flagValue(args, "--tools"),
    "+structured_output,+pipeline_commit",
  );
});

test("a missing agent definition fails its launch with an error naming the agent", async () => {
  const sessions = path.join(agentDir, "sessions");
  const raw = sessionRawOf(
    await runLaunch(specFor("issue-pipeline-nobody"), hooksIn(sessions)),
  );
  assert.equal(raw.ok, false);
  assert.equal(raw.structuredOutput, null);
  assert.match(raw.error ?? "", NOBODY);
  assert.equal(raw.key, "i7-spec-4");
});
