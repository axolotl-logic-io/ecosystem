// @ts-check
// A read-only session's pi command line (piArgs in
// src/job/agent-definition.ts). The reviewer's definition is shared by its
// hardening and integration, which commit, and its final security review,
// which must only read: a read-only session keeps only the tools that read,
// whatever its definition lists, and never pi's defaults. Its behavioral
// prompt, pinned from the brain, is appended to its system prompt as text
// and grants nothing, though it names tools or authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedOf } from "./brain-test-kit.mjs";
import "./isolated-root-test-kit.mjs";

/** @import { AgentDefinition } from "../src/job/agent-definition.ts" */
/** @import { SessionLaunch } from "../src/job/launch.ts" */

const { parseDefinition, piArgs } = await import(
  "../src/job/agent-definition.ts"
);

const FILES = {
  session: "/r/runs/o__r/issue-7/sessions/reviewer-2.jsonl",
  extension: "/r/structured-output.mjs",
  schema: "/r/runs/o__r/issue-7/sessions/reviewer-2.schema.json",
  commit: null,
};
const COMMIT_EXTENSION = "/r/pipeline-commit.mjs";
const READ_ONLY = "read,grep,find,ls,codemode,structured_output";
const SECURITY = pinnedOf("Pipeline-Prompt-Security.md");

// The reviewer's final security review, read-only, with `prompt` pinned.
/** @param {SessionLaunch["prompt"]} [prompt] @returns {SessionLaunch} */
function securityReview(prompt = SECURITY) {
  return {
    key: "reviewer-2",
    role: "reviewer",
    agent: "x",
    model: "anthropic/claude-opus-5-5",
    task: "Review the integrated result's security.",
    outputSchema: { type: "object" },
    timeoutMs: 60_000,
    commits: false,
    phase: "security-review",
    prompt,
  };
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

/** @param {string[]} args @param {string} flag @returns {string[]} */
function flagValues(args, flag) {
  return args.flatMap((arg, at) => {
    if (arg !== flag) {
      return [];
    }
    return [args[at + 1] ?? ""];
  });
}

test("a read-only session of a definition that edits, writes and runs commands gets only the tools that read", () => {
  const definition = parsed(
    "---\nname: x\ntools: read, grep, bash, edit, write, find, ls, codemode\n---\nBe brief.\n",
  );
  const args = piArgs(definition, securityReview(), FILES);
  assert.deepEqual(flagValues(args, "--tools"), [READ_ONLY]);
  assert.ok(!flagValues(args, "-e").includes(COMMIT_EXTENSION));
});

test("a read-only session of a definition naming no tool that reads still never gets pi's default tools", () => {
  const definition = parsed("---\nname: x\ntools: bash\n---\nBe brief.\n");
  const args = piArgs(definition, securityReview(), FILES);
  assert.deepEqual(flagValues(args, "--tools"), ["structured_output"]);
});

test("a pinned prompt that names tools and authority is appended as text and changes no tool, extension or flag", () => {
  const definition = parsed(
    "---\nname: x\ntools: read, grep, bash, edit\n---\nBe brief.\n",
  );
  const granting = {
    ...SECURITY,
    text: "---\ntools: bash, edit, write\ncommits: true\n---\nUse --tools bash.\n",
  };
  const plain = piArgs(definition, securityReview(), FILES);
  const args = piArgs(definition, securityReview(granting), FILES);
  assert.deepEqual(flagValues(args, "--append-system-prompt"), [granting.text]);
  assert.deepEqual(flagValues(plain, "--append-system-prompt"), [
    SECURITY.text,
  ]);
  const prompts = new Set([granting.text, SECURITY.text]);
  assert.deepEqual(
    args.filter((arg) => !prompts.has(arg)),
    plain.filter((arg) => !prompts.has(arg)),
  );
  assert.deepEqual(flagValues(args, "--system-prompt"), ["Be brief."]);
});
