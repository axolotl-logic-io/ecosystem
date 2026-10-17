// @ts-check
// The spec writer's scope rule on zod schemas (src/type-only-additions.ts,
// src/zod-schemas.ts): in a file of a declared `changed` interface, any
// change to a zod schema passes, new schema constants and their exports
// included (Axlog, 2026-10-17: "Schema changes are okay"), while runtime code
// outside the schemas, such as a function body, a plain object or a parse,
// still fails as not-allowed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARGS_END,
  ARGS_LANES,
  check,
  DEFAULTS_END,
  editedSettings,
  INTERFACE_END,
  LANES_OF_BODY,
  NOT_ALLOWED,
  outcome,
  PASSED,
  SETTINGS,
  VALUE_EXPORTS,
} from "./spec-tests-scope-test-kit.mjs";

test("an added optional zod property in a changed interface's file passes", () => {
  const optional = editedSettings([
    [
      ARGS_END,
      [
        "  // The roles the schedule runs, or every role when unset.",
        '  roles: z.array(z.enum(["spec", "implement"])).optional(),',
        "  label: z",
        "    .string()",
        "    .nullish(),",
      ],
    ],
    [INTERFACE_END, ["  roles?: readonly Role[];"]],
  ]);
  assert.deepEqual(check(optional), PASSED);
});

test("an added required zod property in a changed interface's file passes", () => {
  const required = editedSettings([
    [ARGS_END, ["  roles: z.array(z.string()),"]],
  ]);
  assert.deepEqual(check(required), PASSED);
});

test("a changed zod property in a changed interface's file passes", () => {
  const changed = editedSettings(
    [[ARGS_LANES, ["  lanes: z.number().int().min(1).optional(),"]]],
    ARGS_LANES,
  );
  assert.deepEqual(check(changed), PASSED);
});

test("a new exported zod schema constant in a changed interface's file passes", () => {
  const added = editedSettings(
    [
      [
        VALUE_EXPORTS - 1,
        [
          "const ROLES_ARGS = SCHEDULE_ARGS.extend({",
          "  roles: z.array(z.string()),",
          "});",
          "",
          "export const LABEL = z.string().min(1);",
          "",
        ],
      ],
      [
        VALUE_EXPORTS,
        ["export { DEFAULTS, lanesOf, ROLES_ARGS, SCHEDULE_ARGS };"],
      ],
    ],
    VALUE_EXPORTS,
  );
  assert.deepEqual(check(added), PASSED);
});

test("a changed function body in a changed interface's file fails as not-allowed", () => {
  const changed = editedSettings(
    [[LANES_OF_BODY, ["  return settings.lanes + 1;"]]],
    LANES_OF_BODY,
  );
  assert.deepEqual(outcome(check(changed), [SETTINGS, "removes"]), NOT_ALLOWED);
  const added = editedSettings([[LANES_OF_BODY, ["  console.log(settings);"]]]);
  assert.deepEqual(
    outcome(check(added), [SETTINGS, "runtime code"]),
    NOT_ALLOWED,
  );
});

test("an added zod value in a plain object of a changed interface's file fails", () => {
  const added = ["  roles: z.array(z.string()).optional(),"];
  const got = check(editedSettings([[DEFAULTS_END, added]]));
  assert.deepEqual(outcome(got, [SETTINGS, "runtime code"]), NOT_ALLOWED);
});

test("a parse with a zod schema is runtime code, not a schema", () => {
  const added = ["const parsed = SCHEDULE_ARGS.parse({ lanes: 2 });", ""];
  const got = check(editedSettings([[VALUE_EXPORTS - 1, added]]));
  assert.deepEqual(outcome(got, [SETTINGS, "runtime code"]), NOT_ALLOWED);
});
