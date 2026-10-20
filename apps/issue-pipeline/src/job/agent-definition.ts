// The pipeline's installed agent definitions, as a stage job runs them: the
// definition's frontmatter and system prompt, read from
// $PI_CODING_AGENT_DIR/agents/issue-pipeline/<agent>.md, and the `pi`
// command line that runs a session as that agent.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AGENT_DIR } from "../pipeline-root.ts";
import { COMMIT_TOOL } from "./pipeline-commit.ts";

const FRONTMATTER =
  /^---\r?\n(?<head>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/u;
// A top-level `key: value` line; indented lines belong to a nested value.
const FIELD = /^(?<key>[A-Za-z]\w*):\s*(?<value>.*)$/u;
const LINE_BREAK = /\r?\n/u;
const LIST_SEPARATOR = /\s*,\s*/u;
const OUTPUT_TOOL = "structured_output";
// The tools a session that only reads may have: none edits, writes or runs
// a command. A codemode script calls only the session's other tools.
const READ_ONLY_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "codemode",
];

const SETTING = z.enum(["true", "false"]).optional();
const FIELDS = z.looseObject({
  tools: z.string().optional(),
  thinking: z.string().optional(),
  subagentOnlyExtensions: z.string().optional(),
  inheritProjectContext: SETTING,
  inheritSkills: SETTING,
});

// What a definition sets for its sessions.
interface AgentDefinition {
  tools: readonly string[];
  thinking: string | null;
  extensions: readonly string[];
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  systemPrompt: string;
}

// A definition, or why it couldn't be read.
type DefinitionRead =
  | { kind: "found"; definition: AgentDefinition }
  | { kind: "missing"; error: string };

// The files a session uses: its JSONL session, the structured-output
// extension, the JSON Schema file that extension reads, and the
// pipeline_commit extension a committing session loads (null for a session
// that only reads).
interface SessionFiles {
  session: string;
  extension: string;
  schema: string;
  commit: string | null;
}

function listOf(value: string | undefined): string[] {
  return (value ?? "").split(LIST_SEPARATOR).filter((entry) => entry !== "");
}

function fieldsOf(head: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of head.split(LINE_BREAK)) {
    const { key, value } = FIELD.exec(line)?.groups ?? {};
    if (key !== undefined && value !== undefined) {
      fields[key] = value.trim();
    }
  }
  return fields;
}

// The definition in an agent file's text, or null when it has no
// frontmatter or a field is malformed.
function parseDefinition(text: string): AgentDefinition | null {
  const { head, body } = FRONTMATTER.exec(text)?.groups ?? {};
  if (head === undefined || body === undefined) {
    return null;
  }
  const fields = FIELDS.safeParse(fieldsOf(head));
  if (!fields.success) {
    return null;
  }
  const { data } = fields;
  return {
    tools: listOf(data.tools),
    thinking: data.thinking ?? null,
    extensions: listOf(data.subagentOnlyExtensions),
    inheritProjectContext: data.inheritProjectContext !== "false",
    inheritSkills: data.inheritSkills !== "false",
    systemPrompt: body.trim(),
  };
}

// The installed definition of `agent`. A missing, unreadable or malformed
// file is "missing", with an error that names the agent.
function readDefinition(agent: string): DefinitionRead {
  const file = path.join(AGENT_DIR, "agents", "issue-pipeline", `${agent}.md`);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {
      kind: "missing",
      error: `agent ${agent}: no definition at ${file}`,
    };
  }
  const definition = parseDefinition(text);
  if (definition === null) {
    return { kind: "missing", error: `agent ${agent}: ${file} is malformed` };
  }
  return { kind: "found", definition };
}

// The tools flag: the definition's tools and `added`, or, when it names
// none, pi's default tools with `added` added. A `codemode` script calls only
// these tools, with one exception in pi: an allowlist that names no `mcp__`
// tool keeps every MCP server's tools callable through codemode. No MCP server
// is configured for pipeline sessions; one that is would widen every role.
function toolsFlag(tools: readonly string[], added: readonly string[]): string {
  if (tools.length === 0) {
    return added.map((tool) => `+${tool}`).join(",");
  }
  return [...tools, ...added].join(",");
}

// The tools flag of a session that only reads, for a definition that lists
// `tools`: those of them that only read, or all READ_ONLY_TOOLS when the
// definition lists none, since pi's defaults edit, write and run commands;
// and `added`. The list is always explicit, never added to pi's defaults.
function readOnlyToolsFlag(
  tools: readonly string[],
  added: readonly string[],
): string {
  let kept = READ_ONLY_TOOLS;
  if (tools.length > 0) {
    kept = tools.filter(
      (tool) => READ_ONLY_TOOLS.includes(tool) || tool === "git_review",
    );
  }
  return [...kept, ...added].join(",");
}

// The `pi` arguments that run a session on `spec.model` as `definition` in
// RPC mode, which takes its task as a command on stdin, with `spec.prompt`'s
// text, its behavioral prompt, appended to the definition's system prompt as text
// (`--append-system-prompt`), writing its session to
// `files.session` and ending on the structured_output tool. A session given
// `files.commit` commits: it also gets the pipeline_commit tool. Any other
// only reads: of its definition's tools it keeps only those that read, so a
// definition shared with committing sessions never lets it edit, write or
// run a command.
function piArgs(
  definition: AgentDefinition,
  spec: { model: string; prompt: { text: string } },
  files: SessionFiles,
): string[] {
  // Pi 1.2.0 keeps explicit RPC authoritative over --print. The latter
  // selects pi-cliproxyapi 0.4.3's existing cache-only child behavior.
  const args = [
    "--mode",
    "rpc",
    "--print",
    "--offline",
    "--no-approve",
    "--no-extensions",
    "-e",
    "builtin:codemode",
    "-nc",
    "-ns",
    "-np",
    "--no-themes",
    "--model",
    spec.model,
  ];
  if (definition.thinking !== null) {
    args.push("--thinking", definition.thinking);
  }
  if (files.commit === null) {
    args.push("--tools", readOnlyToolsFlag(definition.tools, [OUTPUT_TOOL]));
  } else {
    const added = [OUTPUT_TOOL, COMMIT_TOOL];
    args.push("--tools", toolsFlag(definition.tools, added));
  }
  args.push("--system-prompt", definition.systemPrompt);
  args.push("--append-system-prompt", spec.prompt.text);
  for (const extension of definition.extensions) {
    args.push("-e", extension);
  }
  args.push("--session", files.session);
  args.push("-e", files.extension, "--output-schema", files.schema);
  if (files.commit !== null) {
    args.push("-e", files.commit);
  }
  return args;
}

export type { AgentDefinition, DefinitionRead, SessionFiles };
export { parseDefinition, piArgs, READ_ONLY_TOOLS, readDefinition };
