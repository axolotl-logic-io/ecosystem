// @ts-check
// The re-review schemas, the spec schema, and the lenses the review rounds
// run.
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

const NEW_FINDING_REQUIRED = [
  "file",
  "line",
  "title",
  "evidence",
  "suggestion",
  "recursId",
];

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

// `schema` with a required harm category added last to its new findings.
/** @param {JsonSchema} schema @returns {JsonSchema} */
function withHarmCategory(schema) {
  const { properties = {} } = schema;
  const { newFindings } = properties;
  const items = newFindingSchema(schema);
  const { properties: fields = {}, required = [] } = items;
  return {
    ...schema,
    properties: {
      ...properties,
      newFindings: {
        ...newFindings,
        items: {
          ...items,
          properties: { ...fields, category: { enum: [...HARM_CATEGORIES] } },
          required: [...required, "category"],
        },
      },
    },
  };
}

test("the re-review schema's new findings carry no category", () => {
  const items = newFindingSchema(REREVIEW_SCHEMA);
  assert.deepEqual(items.required, NEW_FINDING_REQUIRED);
  assert.equal(Object.hasOwn(items.properties ?? {}, "category"), false);
});

test("the security re-review schema adds a required harm category last", () => {
  const want = plain(withHarmCategory(REREVIEW_SCHEMA));
  assert.deepEqual(plain(REREVIEW_SEC_SCHEMA), want);
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
