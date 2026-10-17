// @ts-check
// The spec writer's commit check's scope rule, `not-allowed`
// (src/roles/spec-writer/check-rules.ts), on what a spec may change beside
// its tests, stubs and wiki pages, against a real repo whose base holds
// src/settings.ts. A file that is the `where` of an interface the reply
// declares `changed` may change only by added, type-level lines
// (src/type-only-additions.ts, #417). A file the change adds may change when
// a `new` interface's stub imports it, directly or through other added files
// (src/roles/spec-writer/helper-stubs.ts, #416). A failure names every file
// that may not change. Each case also adds a failing test.
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

const root = fs.mkdtempSync("/tmp/issue-pipeline-spec-scope-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", root);
const { specTestsCheck } = await import("../src/roles/spec-writer/check.ts");
const { loadConfig } = await import("../src/config.ts");

const SETTINGS = "src/settings.ts";
// src/settings.ts at the base, by line.
const SETTINGS_LINES = [
  "// The settings a schedule reads.",
  "interface ScheduleSettings {",
  "  lanes: number;",
  "}",
  "",
  "type Role =",
  '  | "spec"',
  '  | "implement";',
  "",
  "const DEFAULTS = {",
  "  lanes: 1,",
  "};",
  "",
  "export type { Role, ScheduleSettings };",
  "export { DEFAULTS };",
];
// The 1-based lines of SETTINGS_LINES the cases edit at.
const COMMENT_LINE = 1;
const INTERFACE_END = 4;
const UNION_END = 8;
const DEFAULTS_START = 10;
const DEFAULTS_END = 12;

const TIMEOUT_MS = 60_000;
const TEST = "test/a.test.sh";
// A test that fails at the head: src/a.js still says "old".
const FAILING = { [TEST]: "grep -q fixed src/a.js\n" };
const RUN_TESTS =
  'for t in test/*.test.sh; do [ -e "$t" ] || continue; sh "$t" || exit 1; done';

/** @type {CheckedInterface} */
const SCHEDULE_SETTINGS = {
  name: "ScheduleSettings",
  where: `${SETTINGS}:2`,
  status: "changed",
};

/** @param {readonly string[]} text @returns {string} */
function joined(text) {
  return `${text.join("\n")}\n`;
}

const kit = verifyKit(root, { [SETTINGS]: joined(SETTINGS_LINES) });

// src/settings.ts with each of `inserts` (a 1-based line of SETTINGS_LINES
// and the lines inserted before it) applied, and line `removed` dropped.
/** @param {ReadonlyArray<readonly [number, readonly string[]]>} inserts @param {number} [removed] @returns {string} */
function editedSettings(inserts, removed) {
  const edited = SETTINGS_LINES.flatMap((line, index) => {
    const at = index + 1;
    const before = inserts
      .filter(([where]) => where === at)
      .flatMap(([, added]) => added);
    if (at === removed) {
      return before;
    }
    return [...before, line];
  });
  return joined(edited);
}

/** @typedef {{ result: SpecTestsResult, leftovers: object }} Got */

// Runs the check on a branch that commits `files` and a failing test, with
// the reply's `interfaces`, and returns its result with what it left behind.
// The worktree finds the repo's `typescript`, as a set-up one does.
/** @param {Files} files @param {readonly CheckedInterface[]} interfaces @returns {Got} */
function checkFiles(files, interfaces) {
  const { n, sha } = kit.branch({ ...files, ...FAILING });
  kit.linkTypeScript(n);
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
  const commands = { lint: null, typecheck: null, test: RUN_TESTS };
  const result = specTestsCheck(change, { testPathGlobs, commands });
  return { result, leftovers: kit.leftovers(n) };
}

// The check on a branch that commits `settings` as src/settings.ts.
/** @param {string} settings @param {readonly CheckedInterface[]} [interfaces] @returns {Got} */
function check(settings, interfaces = [SCHEDULE_SETTINGS]) {
  return checkFiles({ [SETTINGS]: settings }, interfaces);
}

// A not-allowed failure is judged on which of `named` its reason leaves out.
/** @param {Got} got @param {readonly string[]} named @returns {object} */
function outcome(got, named) {
  const { result, leftovers } = got;
  if (result.pass) {
    return { result, leftovers };
  }
  const unnamed = named.filter((name) => !result.reason.includes(name));
  return { pass: false, rule: result.rule, unnamed, leftovers };
}

const NOT_ALLOWED = {
  pass: false,
  rule: "not-allowed",
  unnamed: [],
  leftovers: CLEAN,
};
const PASSED = { result: { pass: true, wikiOnly: false }, leftovers: CLEAN };

test("type-only additions to a declared changed interface's file pass", () => {
  const typeOnly = editedSettings([
    [COMMENT_LINE, ['import type { Files } from "./files.ts";', ""]],
    [
      INTERFACE_END,
      [
        "  // The roles the schedule runs, or every role when unset.",
        "  roles?: readonly Role[];",
        "  printRoles?: boolean;",
        "  files?: Files;",
      ],
    ],
    [UNION_END, ['  | "review"']],
  ]);
  assert.deepEqual(check(typeOnly), PASSED);
});

test("an added function in a changed interface's file fails as not-allowed", () => {
  const added = ["function roles(): Role[] {", "  return [];", "}", ""];
  const got = check(editedSettings([[DEFAULTS_START, added]]));
  assert.deepEqual(outcome(got, [SETTINGS, "runtime code"]), NOT_ALLOWED);
});

test("an added runtime value in a changed interface's file fails as not-allowed", () => {
  const got = check(editedSettings([[DEFAULTS_END, ["  roles: [],"]]]));
  assert.deepEqual(outcome(got, [SETTINGS, "runtime code"]), NOT_ALLOWED);
});

test("a type-only addition to a file no changed interface names fails", () => {
  const settings = editedSettings([
    [INTERFACE_END, ["  roles?: readonly Role[];"]],
  ]);
  /** @type {CheckedInterface} */
  const existing = { ...SCHEDULE_SETTINGS, status: "existing" };
  for (const interfaces of [[], [existing]]) {
    const got = check(settings, interfaces);
    assert.deepEqual(outcome(got, [SETTINGS, "not a test file"]), NOT_ALLOWED);
  }
});

test("a removed line in a changed interface's file fails as not-allowed", () => {
  const got = check(editedSettings([], COMMENT_LINE));
  assert.deepEqual(outcome(got, [SETTINGS, "removes"]), NOT_ALLOWED);
});

// A new interface's stub, src/finalizer/script.ts, that imports a helper.
const SCRIPT = "src/finalizer/script.ts";
const LOCATE = "src/finalizer/locate.ts";
const DEEP = "src/shared/deep.ts";
const STRAY = "src/finalizer/stray.ts";
/** @type {CheckedInterface} */
const FINALIZE = { name: "finalize", where: SCRIPT, status: "new" };
const SCRIPT_TEXT = [
  'import { locate } from "./locate.ts";',
  "export function finalize(): string {",
  "  return locate();",
  "}",
];

test("added files a new interface's stub imports, directly or transitively, pass", () => {
  const files = {
    [SCRIPT]: joined(SCRIPT_TEXT),
    [LOCATE]: joined([
      'import type { Deep } from "../shared/deep.js";',
      "export function locate(): Deep {",
      '  throw new Error("not implemented");',
      "}",
    ]),
    [DEEP]: "export type Deep = string;\n",
  };
  assert.deepEqual(checkFiles(files, [FINALIZE]), PASSED);
});

test("an added file no stub imports fails, and so does an imported existing file", () => {
  const script = [`import { DEFAULTS } from "../settings.ts";`, ...SCRIPT_TEXT];
  const files = {
    [SCRIPT]: joined(script),
    [LOCATE]: "export function locate(): string { return ''; }\n",
    [STRAY]: "export const stray = 1;\n",
    [SETTINGS]: editedSettings([[DEFAULTS_END, ["  roles: [],"]]]),
  };
  const got = checkFiles(files, [FINALIZE]);
  assert.deepEqual(outcome(got, [STRAY, SETTINGS]), NOT_ALLOWED);
  assert.ok(!(got.result.pass || got.result.reason.includes(LOCATE)));
});

test("a not-allowed failure names every offending file, each with its reason", () => {
  const files = {
    [SETTINGS]: editedSettings([[DEFAULTS_END, ["  roles: [],"]]]),
    [STRAY]: "export const stray = 1;\n",
    "src/a.js": "fixed\n",
  };
  const got = checkFiles(files, [SCHEDULE_SETTINGS]);
  const { result } = got;
  assert.ok(!result.pass);
  const reasons = result.reason.split("\n");
  assert.deepEqual(
    reasons.map((reason) => reason.split(" ")[0]),
    ["src/a.js", STRAY, SETTINGS],
  );
  assert.ok(reasons[2]?.includes("runtime code"));
  assert.ok(reasons[0]?.includes("not a test file"));
});
