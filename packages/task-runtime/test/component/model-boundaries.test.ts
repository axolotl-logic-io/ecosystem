import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition, piArgs } from "../../src/job/agent-definition.ts";
import {
  COMMIT_SCOPE_ENV,
  commitArgsOf,
  type PathScope,
} from "../../src/job/pipeline-commit.ts";
import { modelEnvironment } from "../../src/model-environment.ts";

test("model children receive no inherited GitHub, database or commit authority", (): void => {
  assert.deepEqual(
    modelEnvironment(
      Object.fromEntries([
        ["PATH", "/toolchain"],
        ["GH_TOKEN", "github-value"],
        ["DATABASE_URL", "database-value"],
        ["PRIVATE_BOT_KEY", "private-value"],
        ["GIT_CONFIG_KEY_0", "credential.helper"],
        ["GIT_TRACE", "1"],
        [COMMIT_SCOPE_ENV, "inherited-authority"],
      ]),
      ["PRIVATE_BOT_KEY"],
    ),
    Object.fromEntries([["PATH", "/toolchain"]]),
  );
});

test("a read-only session cannot inherit editing tools from its agent definition", (): void => {
  const definition = parseDefinition(
    "---\ntools: read, write, edit, bash, git_review\n---\nRead the code.",
  );
  assert.ok(definition);
  const args = piArgs(
    definition,
    { model: "provider/model", prompt: { text: "Task facts\nRead only." } },
    {
      session: "/artifacts/session.jsonl",
      extension: "/trusted/output.mjs",
      schema: "/artifacts/schema.json",
      commit: null,
    },
  );
  const tools = args[args.indexOf("--tools") + 1];
  assert.equal(tools, "read,git_review,structured_output");
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--offline"));
});

test("commit planning refuses escape paths, forbidden flags and read-only access", (): void => {
  const scope: PathScope = {
    repo: { dir: "repo", access: "write" },
    allowed: ["src/**"],
  };
  for (const args of [
    ["-m", "change", "repo/../outside"],
    ["--no-verify", "-m", "change"],
    ["-m", "change", "repo/private/file"],
  ]) {
    assert.equal(commitArgsOf(args, scope, null).kind, "refused");
  }
  assert.deepEqual(
    commitArgsOf(
      ["-m", "change"],
      { ...scope, repo: { dir: "repo", access: "read" } },
      null,
    ),
    {
      kind: "commit",
      code: null,
      paths: [],
      dryRun: false,
    },
  );
});
