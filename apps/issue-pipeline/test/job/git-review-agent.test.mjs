// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isolatedRoot } from "../isolated-root-test-kit.mjs";
import { delivery, fixture } from "./git-review-test-kit.mjs";

const { parseDefinition, piArgs } = await import(
  "../../src/job/agent-definition.ts"
);
const { gitEnvironment } = await import("../../src/job/git-review-process.ts");
/** @import { ReviewTool } from '../../src/job/git-review.ts' */

const BUILD_TIMEOUT_MS = 60_000;
const output = path.join(isolatedRoot, "agent-build");
const extension = path.join(output, "git-review.mjs");

/** @returns {import('../../src/job/agent-definition.ts').AgentDefinition} */
function buildAgent() {
  const built = spawnSync(process.execPath, ["build.ts", output], {
    cwd: new URL("../..", import.meta.url),
    env: gitEnvironment(isolatedRoot),
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (built.status !== 0) {
    throw new Error(built.stderr);
  }
  const source = fs.readFileSync(
    new URL("../../agents/git-reviewer.md", import.meta.url),
    "utf8",
  );
  const definition = parseDefinition(
    source.replaceAll("{{ISSUE_PIPELINE_ROOT}}", output),
  );
  if (definition === null) {
    throw new Error("Malformed agent");
  }
  return definition;
}
const definition = buildAgent();

test("the built agent explicitly loads Git and grants no command or write tool", () => {
  assert.deepEqual(definition.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "git_review",
  ]);
  assert.deepEqual(definition.extensions, [extension]);
  const args = piArgs(
    definition,
    { model: "test/local", prompt: { text: "Review HEAD~1..HEAD" } },
    {
      session: path.join(isolatedRoot, "session.jsonl"),
      extension: path.join(output, "structured-output.mjs"),
      schema: path.join(isolatedRoot, "schema.json"),
      commit: null,
    },
  );
  assert.ok(args.includes(extension));
  assert.equal(
    args[args.indexOf("--tools") + 1],
    "read,grep,find,ls,git_review,structured_output",
  );
  assert.ok(args.includes("--no-extensions"));
  assert.ok(!args.includes("pipeline-commit.mjs"));
});

test("the bundled entry registers one callable tool and resets on a new session", async ({
  mock,
}) => {
  const { repo } = fixture();
  const loaded = await import(pathToFileURL(extension).href);
  assert.equal(typeof loaded.default, "function");
  /** @type {(() => void) | undefined} */
  let start;
  /** @type {ReviewTool[]} */
  const tools = [];
  // Use the actual bundled entry, not a tool name in frontmatter.
  loaded.default({
    on: (/** @type {string} */ event, /** @type {() => void} */ handler) => {
      assert.equal(event, "session_start");
      start = handler;
    },
    registerTool: (/** @type {ReviewTool} */ registered) =>
      tools.push(registered),
  });
  mock.property(
    process,
    "env",
    Object.fromEntries([["PI_GIT_REVIEW_ROOTS", JSON.stringify([repo])]]),
  );
  assert.ok(start);
  start();
  assert.deepEqual(
    tools.map((registered) => registered.name),
    ["git_review"],
  );
  const [tool] = tools;
  assert.ok(tool);
  const first = delivery(
    await tool.execute("one", { cwd: repo, argv: ["rev-parse", "HEAD"] }),
  );
  start();
  const fresh = tools.at(-1);
  assert.ok(fresh);
  const next = delivery(
    await fresh.execute("two", { cwd: repo, argv: ["rev-parse", "HEAD"] }),
  );
  assert.notEqual(next.sessionId, first.sessionId);
  assert.notEqual(next.queryId, first.queryId);
});
