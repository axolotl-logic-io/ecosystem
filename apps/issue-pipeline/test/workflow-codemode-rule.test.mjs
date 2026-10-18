// @ts-check
// Every role batches and filters tool calls through the `codemode` tool: each
// role's task carries one rule on using it, and each role's agent gets the
// tool on its pi command line. The roles are the writers and readers that
// role-sessions-test-kit.mjs builds; the orchestrator's escalation agent is
// covered in orchestrator-escalation-agent.test.mjs. The tests build each
// task from its stage and read the text; they run no model, timer or load.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { parseDefinition, piArgs } from "../src/job/agent-definition.ts";
import { CODEMODE_RULE } from "../src/workflow/prompts.ts";
import { READER_SESSIONS, WRITER_SESSIONS } from "./role-sessions-test-kit.mjs";

/** @import { AgentDefinition } from "../src/job/agent-definition.ts" */

const ROLE_SESSIONS = [...WRITER_SESSIONS, ...READER_SESSIONS];
const FILES = {
  session: "/r/runs/o__r/issue-7/sessions/i7-review-4.jsonl",
  extension: "/r/structured-output.mjs",
  schema: "/r/runs/o__r/issue-7/sessions/i7-review-4.schema.json",
  commit: null,
};

// What each item of the rule is called in its text, case aside.
/** @type {ReadonlyArray<readonly [string, readonly RegExp[]]>} */
const RULE_ITEMS = [
  ["the codemode tool", [/`codemode`/u]],
  [
    "batching independent calls with Promise.all",
    [/\bbatch/iu, /\bindependent\b/iu, /`Promise\.all`/u],
  ],
  [
    "reads, greps, file searches and shell commands where there is bash",
    [
      /\breads\b/iu,
      /\bgreps\b/iu,
      /\bfile searches\b/iu,
      /\bwhere you have bash\b/iu,
    ],
  ],
  [
    "filtering or summarizing large output rather than reading it whole",
    [/\bfilter\b/iu, /\bsummarize\b/iu, /\brather than\b/iu, /\bwhole\b/iu],
  ],
  [
    "test logs, diffs and search results",
    [/\btest logs\b/iu, /\bdiffs\b/iu, /\bsearch results\b/iu],
  ],
  [
    "plain calls for a single small read or an edit",
    [/\bplain tool call/iu, /\bsingle small read\b/iu, /\ban edit\b/iu],
  ],
];

// How many times `task` holds the rule's text.
/** @param {string} task @returns {number} */
function ruleCount(task) {
  return task.split(CODEMODE_RULE).length - 1;
}

// The repo's definition of `agent`, which must parse.
/** @param {string} agent @returns {AgentDefinition} */
function definitionOf(agent) {
  const file = new URL(`../agents/${agent}.md`, import.meta.url);
  const definition = parseDefinition(fs.readFileSync(file, "utf8"));
  if (definition === null) {
    throw new Error(`${agent}'s definition didn't parse`);
  }
  return definition;
}

// The tools on the pi command line a session of `agent` runs with.
/** @param {string} agent @returns {string[]} */
function toolsOf(agent) {
  const args = piArgs(
    definitionOf(agent),
    {
      key: "i7-review-4",
      label: "Review",
      agent,
      model: "anthropic/claude-sonnet-5-5",
      cwd: "/r",
      task: "Review.",
      outputSchema: { type: "object" },
      timeoutMs: 60_000,
      budgetRole: "reviewer",
      tokenBudget: 80_000,
      intercomBridge: { mode: "off" },
    },
    FILES,
  );
  return String(args[args.indexOf("--tools") + 1]).split(",");
}

describe("the codemode rule", () => {
  test("is one named constant with text", () => {
    assert.equal(typeof CODEMODE_RULE, "string");
    assert.notEqual(CODEMODE_RULE.trim(), "");
  });

  for (const [item, patterns] of RULE_ITEMS) {
    test(`names ${item}`, () => {
      for (const pattern of patterns) {
        assert.match(CODEMODE_RULE, pattern);
      }
    });
  }
});

describe("every role's task carries the codemode rule once", () => {
  for (const [who, build] of ROLE_SESSIONS) {
    test(`${who}`, () => {
      const tasks = build().map(({ task }) => task);
      assert.deepEqual(
        tasks.map(ruleCount),
        tasks.map(() => 1),
        `${who}'s tasks carry the rule once`,
      );
    });
  }
});

describe("every role's tool list includes codemode", () => {
  for (const [who, build] of ROLE_SESSIONS) {
    test(`${who}`, () => {
      for (const { agent } of build()) {
        assert.ok(
          toolsOf(agent).includes("codemode"),
          `${who}'s agent ${agent} runs without codemode`,
        );
      }
    });
  }
});
