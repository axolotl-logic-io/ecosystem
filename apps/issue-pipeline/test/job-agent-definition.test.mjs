// @ts-check
// The stage job's agent definitions: the pi command line each of the repo's
// definitions the four stages run (STAGE_AGENTS) gives a session of each
// write authority its stage allows, and the failed session a missing one
// gives. A session that commits gets its definition's tools and
// pipeline_commit; one that only reads, such as the reviewer's final
// security review, keeps only the tools that read, whatever its definition
// lists.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

/** @import { AgentDefinition } from "../src/job/agent-definition.ts" */
/** @import { LaunchHooks, SessionLaunch } from "../src/job/launch.ts" */

// The job reads definitions from $PI_CODING_AGENT_DIR, fixed when its
// modules load, so the variable is set before they are imported. Environment
// variables are named by strings, as install.test.mjs names them.
const agentDir = fs.mkdtempSync(path.join(isolatedRoot, "job-agents-"));
Object.assign(
  process.env,
  Object.fromEntries([["PI_CODING_AGENT_DIR", agentDir]]),
);
const { parseDefinition, piArgs } = await import(
  "../src/job/agent-definition.ts"
);
const { runSession } = await import("../src/job/launch.ts");
const { STAGE_AGENTS } = await import("../src/job/roles.ts");

const FRONTMATTER_FENCE = /^---/u;
const NOBODY = /issue-pipeline-nobody/u;

// Launch hooks that put fresh sessions in `sessions` and record nothing.
/** @param {string} sessions @returns {LaunchHooks} */
function hooksIn(sessions) {
  return {
    sessionFile: (key) => path.join(sessions, `${key}.jsonl`),
    started: () => undefined,
    record: () => undefined,
    ended: () => undefined,
    sessionEnded: () => undefined,
    env: () => ({}),
    cwd: sessions,
    repo: sessions,
  };
}

const FILES = {
  session: "/r/runs/o__r/issue-7/sessions/author-1.jsonl",
  extension: "/r/structured-output.mjs",
  schema: "/r/runs/o__r/issue-7/sessions/author-1.schema.json",
  commit: null,
};
// A writer session's files, which load the pipeline_commit extension.
const WRITER_FILES = { ...FILES, commit: "/r/pipeline-commit.mjs" };

// The author's session launch with installed agent `agent`.
/** @param {string} agent @returns {SessionLaunch} */
function specFor(agent) {
  return {
    key: "author-1",
    role: "author",
    agent,
    model: "anthropic/claude-opus-5-5",
    task: "Write the Gherkin.",
    outputSchema: { type: "object" },
    timeoutMs: 60_000,
    commits: false,
    phase: null,
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

// The tools that only read.
const READ_TOOLS = ["read", "grep", "find", "ls", "codemode"];
const WRITE_TOOLS = ["edit", "write", "bash"];

// What the job promises `definition` runs `spec` with, given `files`: RPC
// mode with the spec's model; for a committing session (`files.commit`) the
// definition's tools plus structured_output and pipeline_commit, and the
// pipeline_commit extension; for any other, only the definition's tools that
// read plus structured_output; its thinking, prompt, extensions and context
// settings, and the job's session file, output extension and schema.
/** @param {AgentDefinition} definition @param {SessionLaunch} spec @param {typeof FILES | typeof WRITER_FILES} files @returns {CommandLine} */
function promisedCommandLine(definition, spec, files) {
  let tools = [
    ...definition.tools.filter((tool) => READ_TOOLS.includes(tool)),
    "structured_output",
  ];
  const extensions = [...definition.extensions, FILES.extension];
  if (files.commit !== null) {
    tools = [...definition.tools, "structured_output", "pipeline_commit"];
    extensions.push(files.commit);
  }
  return {
    mode: "rpc",
    model: spec.model,
    tools: tools.join(","),
    thinking: definition.thinking,
    systemPrompt: definition.systemPrompt,
    extensions: new Set(extensions),
    skills: definition.inheritSkills,
    projectContext: definition.inheritProjectContext,
    session: FILES.session,
    schema: FILES.schema,
  };
}

test("the pipeline root and agent folder the definitions load from are the test's temporary ones", () => {
  assert.equal(fs.statSync(isolatedRoot).isDirectory(), true);
  assert.ok(agentDir.startsWith(isolatedRoot));
});

// Each stage's agent, with each write authority its stage allows.
const STAGE_SESSIONS = Object.entries(STAGE_AGENTS).flatMap(
  ([stage, { agent, commits }]) =>
    commits.map((commit) => ({ stage, agent, commits: commit })),
);

test("the author, implementor and reviewer stages run their own agents, and merge runs the reviewer both committing and read-only", () => {
  assert.deepEqual(
    STAGE_SESSIONS.map(({ stage, agent, commits }) => [stage, agent, commits]),
    [
      ["author", "issue-pipeline-author", false],
      ["implement", "issue-pipeline-implementor", true],
      ["review", "issue-pipeline-reviewer", true],
      ["review", "issue-pipeline-reviewer", false],
      ["merge", "issue-pipeline-reviewer", true],
      ["merge", "issue-pipeline-reviewer", false],
    ],
  );
});

for (const { stage, agent, commits } of STAGE_SESSIONS) {
  test(`${agent}'s ${stage} session with commits ${commits} runs pi in RPC mode as its definition and authority say`, () => {
    const definition = definitionOf(agent);
    const spec = { ...specFor(agent), commits };
    /** @type {typeof FILES | typeof WRITER_FILES} */
    let files = FILES;
    if (commits) {
      files = WRITER_FILES;
    }
    assert.deepEqual(
      commandLineOf(piArgs(definition, spec, files)),
      promisedCommandLine(definition, spec, files),
    );
    assert.ok(definition.systemPrompt.length > 0);
    assert.doesNotMatch(definition.systemPrompt, FRONTMATTER_FENCE);
  });
}

// The author writes only the Gherkin: its definition neither edits, writes
// nor runs commands.
test("issue-pipeline-author only reads", () => {
  const { tools } = definitionOf("issue-pipeline-author");
  for (const tool of WRITE_TOOLS) {
    assert.equal(tools.includes(tool), false, tool);
  }
  assert.ok(tools.includes("read"));
});

test("the implementor may edit, write and run commands", () => {
  const { tools } = definitionOf("issue-pipeline-implementor");
  for (const tool of ["edit", "write", "bash"]) {
    assert.ok(tools.includes(tool), tool);
  }
});

test("a definition without project context or a tools list runs with -nc, and a read-only session gets only the tools that read", () => {
  const definition = parsed(
    "---\nname: x\ninheritProjectContext: false\ninheritSkills: true\n---\nBe brief.\n",
  );
  const args = piArgs(definition, specFor("x"), FILES);
  assert.ok(args.includes("-nc"));
  assert.ok(!args.includes("-ns"));
  assert.ok(!args.includes("--thinking"));
  assert.equal(
    flagValue(args, "--tools"),
    [...READ_TOOLS, "structured_output"].join(","),
  );
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
  const raw = await runSession(
    specFor("issue-pipeline-nobody"),
    hooksIn(sessions),
  );
  assert.equal(raw.ok, false);
  assert.equal(raw.structuredOutput, null);
  assert.match(raw.error ?? "", NOBODY);
  assert.equal(raw.key, "author-1");
});
