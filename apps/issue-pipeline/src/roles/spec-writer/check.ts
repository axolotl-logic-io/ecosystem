// The spec writer's commit check, `spec-tests-check` (the wiki's
// Pipeline-Roles-Spec-Writer): the spec writer's commits hold only test files,
// the stubs of the `new` interfaces its spec documents, the added files those
// stubs import (helper-stubs.ts), type-only additions to the files of its
// `changed` interfaces and wiki pages; the stubs exist, lint and type-check;
// the wiki change is clean; and the new tests fail at the spec head but pass
// with the test files put back as they were at the base, so the stubs broke
// nothing. With
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
import { SPEC_DRAFT } from "../../spec-draft.ts";
import { LINE_ANCHOR } from "../../spec-files.ts";
import { typeOnlyAdditionsFault } from "../../type-only-additions.ts";
import type { WikiChange } from "../../wiki-check.ts";
import type { Facts, Failure } from "./check-rules.ts";
import { scopeFailure, testFilesFailure, wikiFailure } from "./check-rules.ts";
import { helperStubs } from "./helper-stubs.ts";

// The part of a test interface entry the check reads.
interface CheckedInterface {
  name: string;
  where: string;
  status: "existing" | "new" | "changed";
}

// The spec writer's change: issue `number`'s worktree `wt`, checked out at the
// spec head `sha` and set up, the `base` it started from, the reply's
// `wikiOnly`, `interfaces` and `noTestsReason`, the issue's wiki change, and
// where the check's logs go.
interface SpecTestsChange {
  cfg: Config;
  number: number;
  wt: string;
  base: string;
  sha: string;
  logDir: string;
  timeoutMs: number;
  wikiOnly: boolean;
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

// A pass says whether the change is wiki-only: `noTestsReason` is set and the
// reply says the wiki is the whole change. A failure names the first rule the
// change breaks, and why.
type SpecTestsResult =
  | { pass: true; wikiOnly: boolean }
  | ({ pass: false } & Failure);

const REVERTED_LABEL = "spec-tests-reverted";

// The files the change changes, or with `--diff-filter=A` only those it adds.
function changedFiles(change: SpecTestsChange, ...filter: string[]): string[] {
  const range = `${change.base}...${change.sha}`;
  return run("git", ["-C", change.wt, "diff", "--name-only", ...filter, range])
    .stdout.split("\n")
    .filter((file) => file !== "");
}

// Each file of `changed` that is the `where` (without a line anchor) of a
// `changed` interface, with why its change since the merge base is not
// type-only additions, or null when it is.
function extendedFiles(
  change: SpecTestsChange,
  changed: readonly string[],
): Map<string, string | null> {
  const declared = new Set(
    change.interfaces
      .filter((entry) => entry.status === "changed")
      .map((entry) => entry.where.replace(LINE_ANCHOR, "")),
  );
  const files = changed.filter((file) => declared.has(file));
  if (files.length === 0) {
    return new Map();
  }
  const { wt, base, sha } = change;
  const from = run("git", ["-C", wt, "merge-base", base, sha]).stdout.trim();
  return new Map(
    files.map((file) => [file, typeOnlyAdditionsFault(wt, file, from, sha)]),
  );
}

function factsOf(change: SpecTestsChange, settings: SpecTestsSettings): Facts {
  const wikiPrefix = `${wikiCfg(change.cfg)?.dir ?? "wiki"}/`;
  // The spec draft leaves the branch once the spec is posted (#335).
  const changed = changedFiles(change).filter((file) => file !== SPEC_DRAFT);
  const stubs = change.interfaces
    .filter((entry) => entry.status === "new")
    .map((entry) => entry.where);
  const added = changedFiles(change, "--diff-filter=A");
  const head = { wt: change.wt, rev: change.sha };
  return {
    changed,
    wikiOnly: change.wikiOnly,
    noTestsReason: change.noTestsReason,
    stubs,
    helpers: helperStubs(head, stubs, added),
    extended: extendedFiles(change, changed),
    tests: changed.filter((file) => matchAny(settings.testPathGlobs, file)),
    wikiPages: (change.wiki?.changed ?? []).map(
      (page) => `${wikiPrefix}${page}`,
    ),
    wikiPrefix,
  };
}

// Between the names of an interface entry that groups several, such as
// "TABLE, LIMITS and transition": a comma, with or without a following "and",
// or " and ".
const NAME_SEPARATOR = /\s*,\s*(?:and\s+)?|\s+and\s+/u;

// The names an interface entry's `name` gives: one, or each of a group. Each
// is part of `name`, so a stub that names the whole entry names each of them.
function interfaceNames(name: string): string[] {
  return name
    .split(NAME_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// Each `new` interface's stub file exists at the spec head and names each of
// the entry's names. A failure names only the names the stub lacks.
function stubFailure(change: SpecTestsChange): Failure | null {
  const stubs = change.interfaces.filter((entry) => entry.status === "new");
  for (const { name, where } of stubs) {
    const object = `${change.sha}:${where}`;
    const exists = run("git", ["-C", change.wt, "cat-file", "-e", object], {
      allowFail: true,
    });
    if (exists.code !== 0) {
      const reason = `${where}, the stub of new interface ${name}, does not exist`;
      return { rule: "stub-missing", reason };
    }
    const text = run("git", ["-C", change.wt, "show", object]).stdout;
    const missing = interfaceNames(name).filter((one) => !text.includes(one));
    if (missing.length > 0) {
      const reason = `${where}, a new interface's stub, does not name ${missing.join(", ")}`;
      return { rule: "stub-missing", reason };
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

// The rules the change breaks among those that only read git, in the check's
// order: the scope, the stubs, and the tests and work left to build. Each
// failure is one rule's first; empty when all of them pass. The session's
// reply check runs these while the session can still fix them.
function gitOnlyFailures(
  change: SpecTestsChange,
  settings: SpecTestsSettings,
): Failure[] {
  const facts = factsOf(change, settings);
  return [
    scopeFailure(facts),
    stubFailure(change),
    testFilesFailure(facts),
  ].filter((failure) => failure !== null);
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
  const wikiOnly = change.wikiOnly && change.noTestsReason !== null;
  return { pass: true, wikiOnly };
}

export type { Failure, SpecTestsRule } from "./check-rules.ts";
export type {
  CheckedInterface,
  SpecTestsChange,
  SpecTestsResult,
  SpecTestsSettings,
};
export { gitOnlyFailures, specTestsCheck };
