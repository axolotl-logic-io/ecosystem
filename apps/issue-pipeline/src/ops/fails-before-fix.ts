// verify's fails-before-fix check: a change's tests must fail once its other
// code changes are reverted, or they don't prove the change. The reverted run
// happens in a temp worktree under the issue's run dir, removed afterwards.

import fs from "node:fs";
import path from "node:path";
import { updateSubmodules } from "../clone-setup.ts";
import { commentOnlyChange } from "../comment-only.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { matchAny } from "../globs.ts";
import { withCloneLock } from "../locks.ts";
import type { ShellResult } from "../process.ts";
import { run, shell } from "../process.ts";

const SHORT_SHA_LENGTH = 8;

// The settings the check reads from the repo's config.
interface FailsBeforeFixSettings {
  commands: { setup?: string | null | undefined; test: string };
  nonCodePathGlobs: string[];
  requireNewTests: boolean;
  testPathGlobs: string[];
}

// The change to check: the issue's worktree at `sha`, its files changed since
// `base`, and where its logs go.
interface Change {
  cfg: Config;
  number: number;
  settings: FailsBeforeFixSettings;
  wt: string;
  base: string;
  sha: string;
  changed: readonly string[];
  logDir: string;
  timeoutMs: number;
}

// A test run at the head with some files put back as they were at the base:
// the worktree and commits, the commands, where logs go, and the label that
// names the temp worktree and the logs.
interface RevertedTest {
  cfg: Config;
  number: number;
  wt: string;
  base: string;
  sha: string;
  logDir: string;
  timeoutMs: number;
  commands: { setup?: string | null | undefined; test: string };
  label: string;
}

// What verify knows before the check runs.
interface Context {
  testsOnly: boolean;
  testsPass: boolean | undefined;
}

// The check's outcome, with the reverted test run when there was one.
interface Outcome {
  pass: boolean;
  detail: string;
  result?: ShellResult;
}

function revertedOutcome(result: ShellResult): Outcome {
  if (result.code !== 0) {
    return { pass: true, detail: "tests fail with the fix reverted", result };
  }
  const detail =
    "tests still pass with the fix reverted; they do not prove the fix";
  return { pass: false, detail, result };
}

// Reverts each of `code` to the base in `tmp`, deleting the files the change
// added.
function revert(tmp: string, base: string, code: readonly string[]): void {
  for (const file of code) {
    const exists = ["-C", tmp, "cat-file", "-e", `${base}:${file}`];
    if (run("git", exists, { allowFail: true }).code === 0) {
      run("git", ["-C", tmp, "checkout", base, "--", file]);
    } else {
      fs.rmSync(path.join(tmp, file), { force: true, recursive: true });
      run("git", ["-C", tmp, "update-index", "--force-remove", "--", file]);
    }
  }
}

// Runs `files` reverted to the base and the tests, in a temp worktree at the
// head named for `label` and the head, removed afterwards whatever happens.
// Logs go to `<label>-setup.log` and `<label>-test.log` in the log dir.
function revertedTest(
  reverted: RevertedTest,
  files: readonly string[],
): ShellResult {
  const { cfg, wt, sha, logDir, timeoutMs, label } = reverted;
  const tmp = path.join(
    paths.runDir(cfg, reverted.number),
    `${label}-${sha.slice(0, SHORT_SHA_LENGTH)}`,
  );
  const remove = ["-C", wt, "worktree", "remove", "--force", "--force", tmp];
  withCloneLock(cfg, () => {
    run("git", remove, { allowFail: true });
    run("git", ["-C", wt, "worktree", "add", "--detach", tmp, sha]);
  });
  try {
    revert(tmp, reverted.base, files);
    updateSubmodules(cfg, tmp);
    const { setup, test } = reverted.commands;
    if (setup !== undefined && setup !== null && setup !== "") {
      shell(setup, tmp, path.join(logDir, `${label}-setup.log`), timeoutMs);
    }
    return shell(test, tmp, path.join(logDir, `${label}-test.log`), timeoutMs);
  } finally {
    withCloneLock(cfg, () => run("git", remove, { allowFail: true }));
  }
}

// Runs the tests in a temp worktree at the head with `code` reverted.
function revertedRun(change: Change, code: readonly string[]): Outcome {
  const { cfg, number, wt, base, sha, logDir, timeoutMs } = change;
  const { commands } = change.settings;
  const reverted: RevertedTest = {
    base,
    cfg,
    commands,
    label: "fails-before",
    logDir,
    number,
    sha,
    timeoutMs,
    wt,
  };
  return revertedOutcome(revertedTest(reverted, code));
}

function noCodeOutcome(commentOnly: readonly string[]): Outcome {
  if (commentOnly.length > 0) {
    const files = commentOnly.join(", ");
    return { pass: true, detail: `only comments change in ${files}; skipped` };
  }
  return { pass: true, detail: "no code changes; skipped" };
}

function failsBeforeFix(change: Change, context: Context): Outcome {
  const { settings, changed, wt, base, sha } = change;
  const tests = changed.filter((f) => matchAny(settings.testPathGlobs, f));
  const nonTest = changed.filter(
    (f) => !(tests.includes(f) || matchAny(settings.nonCodePathGlobs, f)),
  );
  // A change to comments alone has no behaviour for a test to catch.
  const commentOnly = nonTest.filter((f) =>
    commentOnlyChange(wt, f, base, sha),
  );
  const code = nonTest.filter((f) => !commentOnly.includes(f));
  if (context.testsOnly) {
    // A clean rebase of a head that already passed every check: the proof
    // belongs to the change, which the rebase didn't touch.
    return { pass: true, detail: "shown before the clean rebase; skipped" };
  }
  if (context.testsPass !== true) {
    // A crashing test command would also "fail before the fix".
    const detail = "not run, because the test command fails on the PR";
    return { pass: false, detail };
  }
  if (code.length === 0) {
    return noCodeOutcome(commentOnly);
  }
  if (tests.length === 0) {
    const pass = !settings.requireNewTests;
    return { pass, detail: "the change adds or edits no test files" };
  }
  return revertedRun(change, code);
}

export type { Change, FailsBeforeFixSettings, RevertedTest };
export { failsBeforeFix, revertedTest };
