// @ts-check
// The spec writer's commit check, `spec-tests-check` (src/roles/spec-writer/
// check.ts, #331), against a real repo: each rule that fails the spec
// writer's commits, naming its cause, and the passes, with or without tests
// and wiki-only. The change lists no files (#391): what may change is the
// test files, the stubs, the spec draft and the wiki, and the reply's
// `wikiOnly` says whether the wiki is the whole change. Every case leaves the
// worktree clean and no temp worktree.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";
import { CLEAN, verifyKit, writeConfig } from "./verify-test-kit.mjs";

/** @import { Files } from "./verify-test-kit.mjs" */
/** @import { CheckedInterface, SpecTestsResult } from "../src/roles/spec-writer/check.ts" */
/** @import { WikiChange } from "../src/wiki-check.ts" */

const root = fs.mkdtempSync("/tmp/issue-pipeline-spec-tests-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", root);
const { specTestsCheck } = await import("../src/roles/spec-writer/check.ts");
const { loadConfig } = await import("../src/config.ts");
const kit = verifyKit(root);

const TIMEOUT_MS = 60_000;
// Runs every test file there is, so putting one back changes the outcome.
const RUN_TESTS =
  'for t in test/*.test.sh; do [ -e "$t" ] || continue; sh "$t" || exit 1; done';
const TEST = "test/a.test.sh";
// A test that fails at the head: src/a.js still says "old".
const FAILING = { [TEST]: "grep -q fixed src/a.js\n" };
const STUB = "src/b.js";
const STUB_TEXT = "export function greet() {}\n";
/** @type {CheckedInterface} */
const GREET = { name: "greet", where: STUB, status: "new" };
const REASON = "the change is to the docs alone";
const NO_COMMAND = null;

/**
 * @typedef {object} CaseOptions
 * @property {boolean} [wikiOnly]
 * @property {readonly CheckedInterface[]} [interfaces]
 * @property {string | null} [noTestsReason]
 * @property {WikiChange | null} [wiki]
 * @property {{ lint?: string, typecheck?: string, test?: string }} [commands]
 */

// A wiki change whose one changed page, Page.md, holds `text`; Home links it.
/** @param {string} text @returns {WikiChange} */
function wikiPage(text) {
  const pages = new Map([
    ["Home.md", "[[Page]]\n"],
    ["Page.md", text],
  ]);
  return { pages, changed: ["Page.md"], added: [] };
}

// Runs the check on a branch with `files` committed, and returns its result
// with what it left behind. The reply is not wiki-only unless the case says.
/** @param {Files} files @param {CaseOptions} [options] @returns {Got} */
function check(files, options = {}) {
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
    wikiOnly: options.wikiOnly ?? false,
    interfaces: options.interfaces ?? [],
    noTestsReason: options.noTestsReason ?? null,
    wiki: options.wiki ?? null,
  };
  const commands = {
    lint: NO_COMMAND,
    typecheck: NO_COMMAND,
    test: RUN_TESTS,
    ...options.commands,
  };
  const result = specTestsCheck(change, { testPathGlobs, commands });
  return { result, leftovers: kit.leftovers(n) };
}

/** @typedef {{ result: SpecTestsResult, leftovers: object }} Got */

// What a case is judged on: a pass as it is, and for a failure its rule and
// which of `named` its reason leaves out, with what the check left behind.
/** @param {Got} got @param {readonly string[]} [named] @returns {object} */
function outcome(got, named = []) {
  const { result, leftovers } = got;
  if (result.pass) {
    return { result, leftovers };
  }
  const unnamed = named.filter((name) => !result.reason.includes(name));
  return { pass: false, rule: result.rule, unnamed, leftovers };
}

// A failure on `rule` whose reason names everything it should.
/** @param {string} rule @returns {object} */
function failed(rule) {
  return { pass: false, rule, unnamed: [], leftovers: CLEAN };
}

/** @param {boolean} wikiOnly @returns {object} */
function passed(wikiOnly) {
  return { result: { pass: true, wikiOnly }, leftovers: CLEAN };
}

test("a changed code file that is no test, stub or page fails", () => {
  const got = check({ "src/a.js": "fixed\n", ...FAILING });
  assert.deepEqual(outcome(got, ["src/a.js"]), failed("not-allowed"));
});

test("a failing test plus a wiki page that nothing lists passes", () => {
  const got = check(FAILING, { wiki: wikiPage("Text.\n") });
  assert.deepEqual(outcome(got), passed(false));
});

test("a new interface whose stub file is absent fails", () => {
  const got = check(FAILING, { interfaces: [GREET] });
  assert.deepEqual(outcome(got, [STUB, "greet"]), failed("stub-missing"));
});

test("a new interface whose stub doesn't name it fails", () => {
  const got = check(
    { [STUB]: "export function other() {}\n", ...FAILING },
    { interfaces: [GREET] },
  );
  assert.deepEqual(outcome(got, [STUB, "greet"]), failed("stub-missing"));
});

test("a stub with no test file and no noTestsReason fails", () => {
  const got = check({ [STUB]: STUB_TEXT }, { interfaces: [GREET] });
  assert.deepEqual(outcome(got, ["test file"]), failed("no-tests"));
});

test("a changed test file with noTestsReason set fails", () => {
  const got = check(FAILING, { noTestsReason: REASON });
  assert.deepEqual(outcome(got, [TEST]), failed("tests-with-reason"));
});

test("a wiki-only reply that changed no wiki page has nothing to build", () => {
  const got = check({}, { wikiOnly: true, noTestsReason: REASON });
  assert.deepEqual(
    outcome(got, ["nothing to build"]),
    failed("nothing-to-build"),
  );
});

test("a failing lint command fails, naming its log", () => {
  const got = check(
    { [STUB]: STUB_TEXT, ...FAILING },
    { interfaces: [GREET], commands: { lint: "false" } },
  );
  assert.deepEqual(outcome(got, ["spec-tests-lint.log"]), failed("lint"));
});

test("a stub that doesn't type-check fails through typecheck", () => {
  const typecheck = `! grep -q BROKEN ${STUB}`;
  const got = check(
    { [STUB]: "export function greet() { BROKEN }\n", ...FAILING },
    { interfaces: [GREET], commands: { typecheck } },
  );
  assert.deepEqual(
    outcome(got, ["spec-tests-typecheck.log"]),
    failed("typecheck"),
  );
});

test("a changed wiki page with a broken link fails, naming page and link", () => {
  const got = check(FAILING, { wiki: wikiPage("See [[Missing]].\n") });
  assert.deepEqual(outcome(got, ["Page", "Missing"]), failed("wiki"));
});

test("tests that pass at the spec head fail the check", () => {
  const got = check({ [TEST]: "true\n" });
  assert.deepEqual(outcome(got, ["spec-tests-test.log"]), failed("tests-pass"));
});

test("tests that still fail with the test files put back fail the check", () => {
  const got = check(FAILING, { commands: { test: `sh ${TEST}` } });
  assert.deepEqual(
    outcome(got, ["spec-tests-reverted-test.log"]),
    failed("reverted-fails"),
  );
});

// The stub alone breaks the suite: putting it back too would let it pass.
test("a stub that breaks the suite with the test files put back fails the check", () => {
  const got = check(
    { [STUB]: "export function greet() { BROKEN }\n", ...FAILING },
    {
      interfaces: [GREET],
      commands: { test: `! grep -q BROKEN ${STUB} && ${RUN_TESTS}` },
    },
  );
  assert.deepEqual(
    outcome(got, ["spec-tests-reverted-test.log"]),
    failed("reverted-fails"),
  );
});

test("a stub plus a test that fails through it passes", () => {
  const got = check(
    { [STUB]: STUB_TEXT, [TEST]: `grep -q hello ${STUB}\n` },
    { interfaces: [GREET] },
  );
  assert.deepEqual(outcome(got), passed(false));
});

test("a failing test through an existing interface, with no stub, passes", () => {
  /** @type {CheckedInterface} */
  const existing = { name: "a", where: "src/a.js", status: "existing" };
  assert.deepEqual(
    outcome(check(FAILING, { interfaces: [existing] })),
    passed(false),
  );
});

// A code change the spec writer can't test goes to the implementer with
// nothing committed and nothing listed.
test("noTestsReason with nothing committed, not wiki-only, passes without running the tests", () => {
  const got = check({}, { noTestsReason: REASON, commands: { test: "false" } });
  assert.deepEqual(outcome(got), passed(false));
});

test("noTestsReason with a wiki edit, not wiki-only, passes as a code change", () => {
  const got = check(
    {},
    {
      noTestsReason: REASON,
      wiki: wikiPage("Text.\n"),
      commands: { test: "false" },
    },
  );
  assert.deepEqual(outcome(got), passed(false));
});

test("a clean wiki change from a wiki-only reply is wiki-only", () => {
  const got = check(
    {},
    {
      wikiOnly: true,
      noTestsReason: REASON,
      wiki: wikiPage("Text.\n"),
      commands: { test: "false" },
    },
  );
  assert.deepEqual(outcome(got), passed(true));
});

// The draft leaves the branch once the spec is posted, so it never merges.
test("a failing test plus the spec draft passes", () => {
  const draft = { ".issue-pipeline/spec-draft.md": "## Behaviour\n" };
  const got = check({ ...draft, ...FAILING });
  assert.deepEqual(outcome(got), passed(false));
});
