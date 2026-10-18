// The spec writer's commit check's rules on what its commits changed: which
// files may change (a `changed` interface's file only by type-only
// additions, and a stub's added imports with it), that tests change unless
// `noTestsReason` is set, that something is left to build, and that the wiki
// change is clean. Pure: src/roles/spec-writer/check.ts reads the commits.

import type { WikiChange, WikiProblem } from "../../wiki-check.ts";
import { wikiProblems } from "../../wiki-check.ts";

type SpecTestsRule =
  | "not-allowed"
  | "stub-missing"
  | "no-tests"
  | "tests-with-reason"
  | "nothing-to-build"
  | "lint"
  | "typecheck"
  | "wiki"
  | "tests-pass"
  | "reverted-fails";

interface Failure {
  rule: SpecTestsRule;
  reason: string;
}

// What the commits changed: every file, the test files and the wiki pages
// (as `<wiki dir>/<page>.md`), with the `new` interfaces' stub files, the
// added files those stubs import, the changed files that are the `where` of
// a `changed` interface, the prefix every wiki page's path starts with, and
// the reply's `wikiOnly` and `noTestsReason`.
interface Facts {
  wikiOnly: boolean;
  noTestsReason: string | null;
  changed: readonly string[];
  tests: readonly string[];
  stubs: readonly string[];
  helpers: readonly string[];
  // Each changed file that is the `where` of a `changed` interface, with why
  // its change is not type-only additions, or null when it is.
  extended: ReadonlyMap<string, string | null>;
  wikiPages: readonly string[];
  wikiPrefix: string;
}

// Why `file` may not change, or null when it may.
function outsideReason(facts: Facts, file: string): string | null {
  const { tests, stubs, helpers, extended, wikiPrefix } = facts;
  const fault = extended.get(file);
  if (
    tests.includes(file) ||
    stubs.includes(file) ||
    helpers.includes(file) ||
    fault === null ||
    file.startsWith(wikiPrefix)
  ) {
    return null;
  }
  if (fault !== undefined) {
    return `${file} changed, and it is the file of a changed interface, but its change is not type-only additions: ${fault}`;
  }
  return `${file} changed, but it is not a test file (testPathGlobs), the stub of a new interface or an added file a stub imports, the file of a changed interface or a wiki page`;
}

// Only test files, stubs and the added files they import, wiki pages and
// type-only additions to the files of `changed` interfaces change. A failure
// names every file that may not, one per line, each with its reason.
function scopeFailure(facts: Facts): Failure | null {
  const reasons = facts.changed.flatMap((file) => {
    const reason = outsideReason(facts, file);
    if (reason === null) {
      return [];
    }
    return [reason];
  });
  if (reasons.length === 0) {
    return null;
  }
  return { rule: "not-allowed", reason: reasons.join("\n") };
}

// Tests change unless `noTestsReason` is set, and then no test or stub does.
function testsChangedFailure(facts: Facts): Failure | null {
  const { changed, tests, stubs } = facts;
  if (facts.noTestsReason === null) {
    if (tests.length > 0) {
      return null;
    }
    const reason =
      "no test file (testPathGlobs) changed, and noTestsReason is not set";
    return { rule: "no-tests", reason };
  }
  const written = changed.find(
    (file) => tests.includes(file) || stubs.includes(file),
  );
  if (written === undefined) {
    return null;
  }
  const reason = `${written} changed, but noTestsReason is set, so no test or stub file may change`;
  return { rule: "tests-with-reason", reason };
}

// The change leaves something to do: a test, a wiki page, or, unless the
// reply says the wiki is the whole change, code for the implementer.
function workFailure(facts: Facts): Failure | null {
  if (facts.tests.length > 0 || facts.wikiPages.length > 0 || !facts.wikiOnly) {
    return null;
  }
  const reason =
    "nothing to build: the reply says the wiki is the whole change, but no test and no wiki page changed";
  return { rule: "nothing-to-build", reason };
}

function problemText(problem: WikiProblem): string {
  switch (problem.kind) {
    case "broken-link":
      return `wiki page ${problem.page} links to ${problem.target}, which is no page`;
    case "orphan":
      return `new wiki page ${problem.page} is linked from no other page`;
    default: {
      const unhandled: never = problem;
      return unhandled;
    }
  }
}

// The changed wiki pages pass `wiki-check`.
function wikiFailure(wiki: WikiChange | null): Failure | null {
  if (wiki === null) {
    return null;
  }
  const problems = wikiProblems(wiki);
  if (problems.length === 0) {
    return null;
  }
  return { rule: "wiki", reason: problems.map(problemText).join("; ") };
}

// Tests change unless `noTestsReason` is set, and something is left to build.
function testFilesFailure(facts: Facts): Failure | null {
  return testsChangedFailure(facts) ?? workFailure(facts);
}

export type { Facts, Failure, SpecTestsRule };
export { scopeFailure, testFilesFailure, wikiFailure };
