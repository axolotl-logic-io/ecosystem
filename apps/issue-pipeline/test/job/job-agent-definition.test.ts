// The stage job's agent definitions: the pi command line each of the repo's
// definitions the four stages run (STAGE_AGENTS) gives each session its
// stage lists, and the failed session a missing one gives. A session that
// commits gets its definition's tools and pipeline_commit; one that only
// reads, such as the reviewer's final security review, keeps only the tools
// that read, whatever its definition lists. Every session's pinned prompt is
// appended to its definition's system prompt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import type { AgentDefinition } from "../../src/job/agent-definition.ts";
import type { LaunchHooks, SessionLaunch } from "../../src/job/launch.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import { pinnedOf } from "../prompt-test-kit.ts";

// The job reads definitions from $PI_CODING_AGENT_DIR, fixed when its
// modules load, so the variable is set before they are imported. Environment
// variables are named by strings, as install.test.ts names them.
const agentDir = fs.mkdtempSync(path.join(isolatedRoot, "job-agents-"));
Object.assign(
  process.env,
  Object.fromEntries([["PI_CODING_AGENT_DIR", agentDir]]),
);
const {
  parseDefinition,
  piArgs,
}: typeof import("../../src/job/agent-definition.ts") = await import(
  "../../src/job/agent-definition.ts"
);
const { runSession }: typeof import("../../src/job/launch.ts") = await import(
  "../../src/job/launch.ts"
);
const { STAGE_AGENTS }: typeof import("../../src/job/roles.ts") = await import(
  "../../src/job/roles.ts"
);

const FRONTMATTER_FENCE = /^---/u;
const PROMPT = pinnedOf("author.md");
const NOBODY = /issue-pipeline-nobody/u;

// Launch hooks that put fresh sessions in `sessions` and record nothing.
function hooksIn(sessions: string): LaunchHooks {
  return {
    sessionFile: (key: string) => path.join(sessions, `${key}.jsonl`),
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
const WRITER_FILES: {
  commit: string;
  session: string;
  extension: string;
  schema: string;
} = { ...FILES, commit: "/r/pipeline-commit.mjs" };

// The author's session launch with installed agent `agent`.
function specFor(agent: string): SessionLaunch {
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
    prompt: PROMPT,
  };
}

function definitionOf(agent: string): AgentDefinition {
  const file = new URL(`../../agents/${agent}.md`, import.meta.url);
  return parsed(fs.readFileSync(file, "utf8"));
}

// The definition in `text`, which must parse.
function parsed(text: string): AgentDefinition {
  const definition = parseDefinition(text);
  if (definition === null) {
    throw new Error("the agent definition didn't parse");
  }
  return definition;
}

// The value after `flag` in `args`, or "" when there is none.
function flagValue(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

// The values that follow each `flag` in `args`.
function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, at) => {
    if (arg !== flag) {
      return [];
    }
    return [args[at + 1] ?? ""];
  });
}

// The value of `flag` in `args`, or null when `args` has no `flag`.
function optionalFlag(args: string[], flag: string): string | null {
  if (!args.includes(flag)) {
    return null;
  }
  return flagValue(args, flag);
}

// What a pi command line sets for its session.
interface CommandLine {
  mode: string | null;
  model: string | null;
  tools: string | null;
  thinking: string | null;
  systemPrompt: string | null;
  appended: string[];
  extensions: Set<string>;
  skills: boolean;
  projectContext: boolean;
  session: string | null;
  schema: string | null;
}

// What `args` sets, read by flag rather than by position.
function commandLineOf(args: string[]): CommandLine {
  return {
    mode: optionalFlag(args, "--mode"),
    model: optionalFlag(args, "--model"),
    tools: optionalFlag(args, "--tools"),
    thinking: optionalFlag(args, "--thinking"),
    systemPrompt: optionalFlag(args, "--system-prompt"),
    appended: flagValues(args, "--append-system-prompt"),
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

// Each session each stage lists, as its stage's agent.
const STAGE_SESSIONS = Object.entries(STAGE_AGENTS).flatMap(
  ([stage, { agent, sessions }]) =>
    sessions.map(({ commits, phase }) => ({ stage, agent, commits, phase })),
);

for (const { stage, agent, commits, phase } of STAGE_SESSIONS) {
  test(`${agent}'s ${stage} ${phase ?? ""} session with commits ${commits} runs pi in RPC mode as its definition and authority say`, () => {
    const definition = definitionOf(agent);
    const spec = { ...specFor(agent), commits, phase };
    let files: typeof FILES | typeof WRITER_FILES = FILES;
    if (commits) {
      files = WRITER_FILES;
    }
    const command = commandLineOf(piArgs(definition, spec, files));
    assert.equal(command.mode, "rpc");
    assert.equal(command.model, spec.model);
    const tools = (command.tools ?? "").split(",");
    assert.equal(tools.includes("pipeline_commit"), commits);
    assert.equal(command.extensions.has(WRITER_FILES.commit), commits);
    const allowed = new Set([...READ_TOOLS, "structured_output"]);
    const writingTools = tools.filter((tool) => !allowed.has(tool));
    assert.equal(writingTools.length === 0 || commits, true);
    assert.deepEqual(command.appended, [spec.prompt.text]);
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
