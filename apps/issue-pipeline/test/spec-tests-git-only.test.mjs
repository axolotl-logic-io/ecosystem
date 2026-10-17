// @ts-check
// The spec writer's commit check's git-only rules, `gitOnlyFailures`
// (src/roles/spec-writer/check.ts), which the session's reply check runs
// while the session can still fix what they find: the scope, the stubs, and
// the tests and work left to build, each failing rule's first failure, read
// from git alone. They run no command, so a change whose tests would fail the
// whole check passes them. Each case leaves the worktree clean.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";
import { CLEAN, verifyKit, writeConfig } from "./verify-test-kit.mjs";

/** @import { Files } from "./verify-test-kit.mjs" */
/** @import { CheckedInterface } from "../src/roles/spec-writer/check.ts" */

const root = fs.mkdtempSync("/tmp/issue-pipeline-spec-git-only-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", root);
const { gitOnlyFailures } = await import("../src/roles/spec-writer/check.ts");
const { loadConfig } = await import("../src/config.ts");
const kit = verifyKit(root);

const TIMEOUT_MS = 60_000;
const TEST = "test/a.test.sh";
// A test that fails at the head: src/a.js still says "old".
const FAILING = { [TEST]: "grep -q fixed src/a.js\n" };
const STUB = "src/b.js";
const STUB_TEXT = "export function greet() {}\n";
/** @type {CheckedInterface} */
const GREET = { name: "greet", where: STUB, status: "new" };
// Commands that would fail the whole check, had they run.
const FAILING_COMMANDS = {
  lint: "exit 1",
  typecheck: "exit 1",
  test: "exit 1",
};

// The rules the git-only check fails, on a branch with `files` committed and
// the reply's `interfaces`, with what it left behind.
/** @param {Files} files @param {readonly CheckedInterface[]} interfaces */
function gitOnly(files, interfaces) {
  const { n, sha } = kit.branch(files);
  const cfg = loadConfig(writeConfig(root, n, {}));
  const { testPathGlobs: globs } = cfg;
  const testPathGlobs = z.array(z.string()).parse(globs);
  const change = {
    cfg,
    number: n,
    wt: kit.worktree(n),
    base: kit.base,
    sha,
    logDir: path.join(kit.runDir(n), "spec-tests"),
    timeoutMs: TIMEOUT_MS,
    wikiOnly: false,
    interfaces,
    noTestsReason: null,
    wiki: null,
  };
  const settings = { testPathGlobs, commands: FAILING_COMMANDS };
  const failures = gitOnlyFailures(change, settings);
  return {
    rules: failures.map(({ rule }) => rule),
    leftovers: kit.leftovers(n),
  };
}

test("the git-only rules give each failing rule's first failure", () => {
  const got = gitOnly({ "src/a.js": "fixed\n", ...FAILING }, [GREET]);
  assert.deepEqual(got, {
    rules: ["not-allowed", "stub-missing"],
    leftovers: CLEAN,
  });
});

test("the git-only rules find a change with no tests", () => {
  const got = gitOnly({ [STUB]: STUB_TEXT }, [GREET]);
  assert.deepEqual(got, { rules: ["no-tests"], leftovers: CLEAN });
});

test("a change the git-only rules pass passes them without running a command", () => {
  const got = gitOnly({ [STUB]: STUB_TEXT, ...FAILING }, [GREET]);
  assert.deepEqual(got, { rules: [], leftovers: CLEAN });
});
