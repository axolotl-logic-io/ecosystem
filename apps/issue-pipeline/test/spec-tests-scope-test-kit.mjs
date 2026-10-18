// @ts-check
// The spec writer's scope rule's tests' repo (spec-tests-scope.test.mjs and
// spec-tests-scope-zod.test.mjs): a real repo whose base holds
// src/settings.ts, with an interface, a union, a runtime object, a zod schema
// and a function; `editedSettings` edits it by line; `check` and
// `checkFiles` run the commit check on a branch that commits the edit and a
// failing test. Importing it sets the pipeline root to a temp folder, so it
// comes before anything a test imports from src/.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
  "const SCHEDULE_ARGS = z.object({",
  "  lanes: z.number(),",
  "});",
  "",
  "function lanesOf(settings: ScheduleSettings): number {",
  "  return settings.lanes;",
  "}",
  "",
  "export type { Role, ScheduleSettings };",
  "export { DEFAULTS, lanesOf, SCHEDULE_ARGS };",
];
// The 1-based lines of SETTINGS_LINES the cases edit at.
const COMMENT_LINE = 1;
const INTERFACE_END = 4;
const UNION_END = 8;
const DEFAULTS_START = 10;
const DEFAULTS_END = 12;
const ARGS_LANES = 15;
const ARGS_END = 16;
const LANES_OF_BODY = 19;
const VALUE_EXPORTS = 23;

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

export {
  ARGS_END,
  ARGS_LANES,
  COMMENT_LINE,
  check,
  checkFiles,
  DEFAULTS_END,
  DEFAULTS_START,
  editedSettings,
  INTERFACE_END,
  joined,
  LANES_OF_BODY,
  NOT_ALLOWED,
  outcome,
  PASSED,
  SCHEDULE_SETTINGS,
  SETTINGS,
  UNION_END,
  VALUE_EXPORTS,
};
