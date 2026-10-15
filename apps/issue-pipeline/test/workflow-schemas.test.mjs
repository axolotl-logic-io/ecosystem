// The re-review schemas, and the lenses the review rounds run.
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

const NEW_FINDING_REQUIRED = [
  "file",
  "line",
  "title",
  "evidence",
  "suggestion",
  "recursId",
];

// A plain copy, so a comparison sees only the schema's JSON.
function plain(schema) {
  return JSON.parse(JSON.stringify(schema));
}

test("the re-review schema's new findings carry no category", () => {
  const { items } = REREVIEW_SCHEMA.properties.newFindings;
  assert.deepEqual(items.required, NEW_FINDING_REQUIRED);
  assert.equal(Object.hasOwn(items.properties, "category"), false);
});

test("the security re-review schema adds a required harm category last", () => {
  const want = plain(REREVIEW_SCHEMA);
  want.properties.newFindings.items.properties.category = {
    enum: [...HARM_CATEGORIES],
  };
  want.properties.newFindings.items.required.push("category");
  assert.deepEqual(plain(REREVIEW_SEC_SCHEMA), want);
});

test("the categories are the four harms", () => {
  assert.deepEqual(HARM_CATEGORIES, [
    "user-harm",
    "rights",
    "financial-harm",
    "abuse-risk",
  ]);
});

test("every lens is a first-round lens or security", () => {
  assert.deepEqual(LENS_NAMES, ["correctness", "tests", "scope"]);
  assert.deepEqual(ALL_LENSES, [...LENS_NAMES, "security"]);
});
