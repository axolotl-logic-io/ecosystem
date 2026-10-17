// The spec writer's commit check, `spec-tests-check` (the wiki's
// Pipeline-Roles-Spec-Writer): the spec writer's commits hold only test files,
// the stubs of the `new` interfaces its spec documents and wiki pages, each
// listed in its `files`; the stubs exist, lint and type-check; the wiki change
// is clean; and the new tests fail at the spec head but pass with the test
// files put back as they were at the base, so the stubs broke nothing. With
// `noTestsReason` set, no test or stub may change and the tests don't run.
// It reads the commits through git and runs the configured commands in the
// spec head's worktree, which the caller checked out and set up; it leaves
// that worktree as it found it.

import path from "node:path";
import type { Config } from "../../config.ts";
import { wikiCfg } from "../../config.ts";
import { matchAny } from "../../globs.ts";
import { revertedTest } from "../../ops/fails-before-fix.ts";
import type { ShellResult } from "../../process.ts";
import { run, shell } from "../../process.ts";
import type { WikiChange } from "../../wiki-check.ts";
import type { Facts, Failure } from "./check-rules.ts";
import { scopeFailure, testFilesFailure, wikiFailure } from "./check-rules.ts";

// The part of a test interface entry the check reads.
interface CheckedInterface {
  name: string;
  where: string;
  status: "existing" | "new" | "changed";
}

// The spec writer's change: issue `number`'s worktree `wt`, checked out at the
// spec head `sha` and set up, the `base` it started from, the reply's `files`,
// `interfaces` and `noTestsReason`, the issue's wiki change, and where the
// check's logs go.
interface SpecTestsChange {
  cfg: Config;
  number: number;
  wt: string;
  base: string;
  sha: string;
  logDir: string;
  timeoutMs: number;
  files: readonly string[];
  interfaces: readonly CheckedInterface[];
  noTestsReason: string | null;
  wiki: WikiChange | null;
}

type Command = string | null | undefined;

// The settings the check reads from the repo's config.
interface SpecTestsSettings {
  testPathGlobs: readonly string[];
  commands: {
    setup?: Command;
    lint?: Command;
    typecheck?: Command;
    test: string;
  };
}

// A pass says whether the change is wiki-only: `noTestsReason` is set and
// every entry of `files` is a wiki page. A failure names the first rule the
// change breaks, and why.
type SpecTestsResult =
  | { pass: true; wikiOnly: boolean }
  | ({ pass: false } & Failure);

const REVERTED_LABEL = "spec-tests-reverted";

function changedFiles(change: SpecTestsChange): string[] {
  const range = `${change.base}...${change.sha}`;
  return run("git", ["-C", change.wt, "diff", "--name-only", range])
    .stdout.split("\n")
    .filter((file) => file !== "");
}

function factsOf(change: SpecTestsChange, settings: SpecTestsSettings): Facts {
  const wikiPrefix = `${wikiCfg(change.cfg)?.dir ?? "wiki"}/`;
  const changed = changedFiles(change);
  return {
    changed,
    files: change.files,
    noTestsReason: change.noTestsReason,
    stubs: change.interfaces
      .filter((entry) => entry.status === "new")
      .map((entry) => entry.where),
    tests: changed.filter((file) => matchAny(settings.testPathGlobs, file)),
    wikiPages: (change.wiki?.changed ?? []).map(
      (page) => `${wikiPrefix}${page}`,
    ),
    wikiPrefix,
  };
}

// Each `new` interface's stub file exists at the spec head and names it.
function stubFailure(change: SpecTestsChange): Failure | null {
  const stubs = change.interfaces.filter((entry) => entry.status === "new");
  for (const { name, where } of stubs) {
    const object = `${change.sha}:${where}`;
    const exists = run("git", ["-C", change.wt, "cat-file", "-e", object], {
      allowFail: true,
    });
    const stub = `${where}, the stub of new interface ${name},`;
    if (exists.code !== 0) {
      return { rule: "stub-missing", reason: `${stub} does not exist` };
    }
    const text = run("git", ["-C", change.wt, "show", object]).stdout;
    if (!text.includes(name)) {
      return { rule: "stub-missing", reason: `${stub} does not name it` };
    }
  }
  return null;
}

function runIn(
  change: SpecTestsChange,
  id: string,
  command: string,
): ShellResult {
  const log = path.join(change.logDir, `spec-tests-${id}.log`);
  return shell(command, change.wt, log, change.timeoutMs);
}

function commandReason(what: string, result: ShellResult): string {
  return `${what} (log ${result.log ?? "none"}):\n${result.tail}`;
}

// The configured lint and typecheck commands pass; an unset one is skipped.
function commandFailure(
  change: SpecTestsChange,
  settings: SpecTestsSettings,
): Failure | null {
  const { lint, typecheck } = settings.commands;
  const commands = new Map<"lint" | "typecheck", Command>([
    ["lint", lint],
    ["typecheck", typecheck],
  ]);
  for (const [rule, command] of commands) {
    if (command !== undefined && command !== null && command !== "") {
      const result = runIn(change, rule, command);
      if (result.code !== 0) {
        const what = `the ${rule} command exited ${result.code}`;
        return { rule, reason: commandReason(what, result) };
      }
    }
  }
  return null;
}

// The test command fails at the spec head and passes with the test files put
// back as they were at the base. Skipped when `noTestsReason` is set.
function testRunFailure(
  change: SpecTestsChange,
  settings: SpecTestsSettings,
  facts: Facts,
): Failure | null {
  if (change.noTestsReason !== null) {
    return null;
  }
  const { commands } = settings;
  const head = runIn(change, "test", commands.test);
  if (head.code === 0) {
    const what =
      "the test command passes at the spec head, so the new tests don't fail";
    return { rule: "tests-pass", reason: commandReason(what, head) };
  }
  const { cfg, number, wt, base, sha, logDir, timeoutMs } = change;
  const reverted = revertedTest(
    {
      base,
      cfg,
      commands,
      label: REVERTED_LABEL,
      logDir,
      number,
      sha,
      timeoutMs,
      wt,
    },
    facts.tests,
  );
  if (reverted.code === 0) {
    return null;
  }
  const what = `the test command exited ${reverted.code} with the new test files put back as they were at the base, so the stubs broke something`;
  return { rule: "reverted-fails", reason: commandReason(what, reverted) };
}

// Checks the spec writer's change against each rule in turn and returns the
// first it breaks, or a pass.
function specTestsCheck(
  change: SpecTestsChange,
  settings: SpecTestsSettings,
): SpecTestsResult {
  const facts = factsOf(change, settings);
  const failed =
    scopeFailure(facts) ??
    stubFailure(change) ??
    testFilesFailure(facts) ??
    commandFailure(change, settings) ??
    wikiFailure(change.wiki) ??
    testRunFailure(change, settings, facts);
  if (failed !== null) {
    return { pass: false, ...failed };
  }
  const wikiOnly =
    change.noTestsReason !== null &&
    change.files.every((file) => file.startsWith(facts.wikiPrefix));
  return { pass: true, wikiOnly };
}

export type { SpecTestsRule } from "./check-rules.ts";
export type {
  CheckedInterface,
  SpecTestsChange,
  SpecTestsResult,
  SpecTestsSettings,
};
export { specTestsCheck };
