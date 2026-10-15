// verify's fails-before-fix check: the change's tests must fail once its code
// changes are reverted, in a temp worktree that verify removes afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { ask, CLEAN, verifyKit, writeConfig } from "./verify-test-kit.mjs";

const root = fs.mkdtempSync("/tmp/issue-pipeline-reverted-fix-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
process.env.ISSUE_PIPELINE_ROOT = root;
const kit = verifyKit(root);
const FIX_AND_TEST = { "src/a.js": "fixed\n", "test/a.test.js": "t\n" };
const FIXED_TEST = "grep -q fixed src/a.js";

// Runs verify on a branch with `files` changed and returns its
// fails-before-fix check with what verify left behind, the reply, and where
// verify keeps its logs.
function failsBeforeFix(files, options = {}) {
  const { commands = {}, extra = {}, request = {}, comments = false } = options;
  const { n, sha } = kit.branch(files);
  if (comments) {
    kit.linkTypeScript(n);
  }
  const config = writeConfig(root, n, commands, extra);
  const reply = ask(root, { op: "verify", config, number: n, ...request });
  const check = reply.checks?.find((c) => c.id === "fails-before-fix");
  return {
    got: { ok: reply.ok, check, leftovers: kit.leftovers(n) },
    reply,
    logs: kit.logs(n, sha),
  };
}

// What a case should get: a reply, the check, and no leftovers.
function wanted(pass, detail, more = {}) {
  return {
    ok: true,
    check: { id: "fails-before-fix", pass, detail, ...more },
    leftovers: CLEAN,
  };
}

test("a tests-only verify, after a clean rebase, skips the check", () => {
  const { got } = failsBeforeFix(FIX_AND_TEST, {
    request: { testsOnly: true },
  });
  assert.deepEqual(got, wanted(true, "shown before the clean rebase; skipped"));
});

test("a failing test command fails the check without running it", () => {
  const { got } = failsBeforeFix(FIX_AND_TEST, { commands: { test: "false" } });
  assert.deepEqual(
    got,
    wanted(false, "not run, because the test command fails on the PR"),
  );
});

test("a change to docs alone has no code to revert", () => {
  const { got } = failsBeforeFix({ "README.md": "# r, again\n" });
  assert.deepEqual(got, wanted(true, "no code changes; skipped"));
});

test("a change to comments alone has no behaviour to test", () => {
  const files = { "src/a.js": "// why\nold\n" };
  const { got } = failsBeforeFix(files, { comments: true });
  assert.deepEqual(
    got,
    wanted(true, "only comments change in src/a.js; skipped"),
  );
});

test("a code change with no test files fails when new tests are required", () => {
  const { got } = failsBeforeFix({ "src/a.js": "fixed\n" });
  assert.deepEqual(
    got,
    wanted(false, "the change adds or edits no test files"),
  );
});

test("a code change with no test files passes when new tests aren't required", () => {
  const extra = { requireNewTests: false };
  const { got } = failsBeforeFix({ "src/a.js": "fixed\n" }, { extra });
  assert.deepEqual(got, wanted(true, "the change adds or edits no test files"));
});

test("tests that fail with the fix reverted pass the check", () => {
  const commands = { setup: "true", test: FIXED_TEST };
  const { got, logs } = failsBeforeFix(FIX_AND_TEST, { commands });
  assert.deepEqual(
    got,
    wanted(true, "tests fail with the fix reverted", {
      log: path.join(logs, "fails-before-test.log"),
    }),
  );
  assert.ok(fs.existsSync(path.join(logs, "fails-before-setup.log")));
});

test("tests that still pass with the fix reverted fail the check", () => {
  const { got, logs, reply } = failsBeforeFix(FIX_AND_TEST);
  const log = path.join(logs, "fails-before-test.log");
  assert.deepEqual(
    got,
    wanted(
      false,
      "tests still pass with the fix reverted; they do not prove the fix",
      { log, tail: "" },
    ),
  );
  assert.equal(reply.pass, false);
});

test("a new code file is deleted, not checked out, when the fix is reverted", () => {
  const files = { "src/b.js": "b\n", "test/b.test.js": "t\n" };
  const commands = { test: "test -f src/b.js" };
  const { got, logs } = failsBeforeFix(files, { commands });
  assert.deepEqual(
    got,
    wanted(true, "tests fail with the fix reverted", {
      log: path.join(logs, "fails-before-test.log"),
    }),
  );
});
