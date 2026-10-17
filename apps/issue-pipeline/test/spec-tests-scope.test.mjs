// @ts-check
// The spec writer's commit check's scope rule, `not-allowed`
// (src/roles/spec-writer/check-rules.ts), on what a spec may change beside
// its tests, stubs and wiki pages, against a real repo whose base holds
// src/settings.ts. A file that is the `where` of an interface the reply
// declares `changed` may change only by added, type-level lines
// (src/type-only-additions.ts, #417), or by changes to its zod schemas
// (spec-tests-scope-zod.test.mjs). A file the change adds may change when a
// `new` interface's stub imports it, directly or through other added files
// (src/roles/spec-writer/helper-stubs.ts, #416). A failure names every file
// that may not change. Each case also adds a failing test.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMENT_LINE,
  check,
  checkFiles,
  DEFAULTS_END,
  DEFAULTS_START,
  editedSettings,
  INTERFACE_END,
  joined,
  NOT_ALLOWED,
  outcome,
  PASSED,
  SCHEDULE_SETTINGS,
  SETTINGS,
  UNION_END,
} from "./spec-tests-scope-test-kit.mjs";

/** @import { CheckedInterface } from "../src/roles/spec-writer/check.ts" */

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
