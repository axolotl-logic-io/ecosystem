// @ts-check
// The re-review schemas, the spec schema, and the lenses the review rounds
// run: the harm categories are the stop labels the wiki's Agent-Labels page
// promises, and the lenses its three-lens-review decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_LENSES,
  HARM_CATEGORIES,
  LENS_NAMES,
} from "../src/workflow/lenses.ts";
import {
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
} from "../src/workflow/review-schemas.ts";
import { SPEC_SCHEMA } from "../src/workflow/schemas.ts";

/** @import { JsonSchema } from "../src/workflow/schemas.ts" */

// A plain copy, so a comparison sees only the schema's JSON.
/** @param {JsonSchema} schema @returns {unknown} */
function plain(schema) {
  return JSON.parse(JSON.stringify(schema));
}

// The schema of one new finding in re-review schema `schema`.
/** @param {JsonSchema} schema @returns {JsonSchema} */
function newFindingSchema(schema) {
  const { properties = {} } = schema;
  const { newFindings } = properties;
  if (newFindings?.items === undefined) {
    throw new Error("the schema has no new findings");
  }
  return newFindings.items;
}

test("the re-review schema's new findings carry no category", () => {
  const { properties = {}, required = [] } = newFindingSchema(REREVIEW_SCHEMA);
  assert.equal(Object.hasOwn(properties, "category"), false);
  assert.equal(required.includes("category"), false);
});

test("the security re-review schema's new findings require a harm category", () => {
  const plainFields = newFindingSchema(REREVIEW_SCHEMA);
  const { properties = {}, required = [] } =
    newFindingSchema(REREVIEW_SEC_SCHEMA);
  const { category = {} } = properties;
  assert.deepEqual(plain(category), { enum: [...HARM_CATEGORIES] });
  assert.deepEqual(
    required.filter((field) => field !== "category").toSorted(),
    (plainFields.required ?? []).toSorted(),
  );
  assert.ok(required.includes("category"));
});

test("the spec schema requires the files the change will touch, as strings", () => {
  const { properties = {}, required = [] } = SPEC_SCHEMA;
  const { files = {} } = properties;
  assert.ok(required.includes("files"));
  assert.deepEqual(plain(files), {
    type: "array",
    items: { type: "string" },
  });
});

test("the categories are the four harms", () => {
  assert.deepEqual(HARM_CATEGORIES, [
    "user-harm",
    "rights",
    "financial-harm",
    "abuse-risk",
  ]);
});

test("every lens is a first-round lens, security or acceptance", () => {
  assert.deepEqual(LENS_NAMES, ["correctness", "tests", "scope"]);
  assert.deepEqual(ALL_LENSES, [...LENS_NAMES, "security", "acceptance"]);
});
