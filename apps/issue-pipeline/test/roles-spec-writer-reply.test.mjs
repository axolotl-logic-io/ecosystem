// @ts-check
// The spec writer role's reply (#333): its schema, and what the pipeline
// reads from each reply. The end marker, the split rules and needs-info
// without questions are ported from the spec stage's tests
// (workflow-stages-spec-next, -retry-next and -split-next).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPEC_WRITER_SCHEMA,
  specReadingOf,
} from "../src/roles/spec-writer/reply.ts";
import { SPEC_SCHEMA } from "../src/workflow/schemas.ts";

/** @import { SpecInterface } from "../src/roles/spec-writer/reply.ts" */
/** @import { JsonSchema } from "../src/workflow/schemas.ts" */

const SPEC_END = "<!-- end of spec -->";
const SPEC = "## Behaviour\n\n- It works.";
const SPLIT_TOO_SMALL = "the spec writer's split had fewer than 2 parts";
const SUB_ISSUE_SPLIT = "a sub-issue can't split again";

/** @type {SpecInterface} */
const INTERFACE = {
  name: "parseQuota",
  kind: "function",
  where: "src/quota.ts",
  status: "new",
  signature: "parseQuota(text: string): number",
  behaviours: ["It works."],
};

/** @param {string} title @returns {{ title: string, body: string, after: number[], files: string[] }} a part */
function part(title) {
  return { title, body: `${title}'s slice`, after: [], files: [] };
}

/**
 * A whole reply: a ready spec with one interface, `fields` replacing its
 * fields.
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, unknown>} the reply
 */
function replyOf(fields = {}) {
  return {
    decision: "ready",
    spec: `${SPEC}\n\n${SPEC_END}\n`,
    questions: [],
    files: ["src/quota.ts"],
    subIssues: [],
    interfaces: [INTERFACE],
    noTestsReason: null,
    ...fields,
  };
}

/** @param {JsonSchema} schema @returns {Map<string, JsonSchema>} its properties, by name */
function propertiesOf(schema) {
  return new Map(Object.entries(schema.properties ?? {}));
}

/** @param {JsonSchema} schema @param {string} where @returns {string[]} the objects that aren't closed or don't require every field */
function openObjects(schema, where) {
  const found = [];
  const { properties } = schema;
  if (properties !== undefined) {
    const names = Object.keys(properties);
    const required = schema.required ?? [];
    if (
      schema.additionalProperties !== false ||
      names.some((name) => !required.includes(name))
    ) {
      found.push(where);
    }
    for (const [name, child] of Object.entries(properties)) {
      found.push(...openObjects(child, `${where}.${name}`));
    }
  }
  if (schema.items !== undefined) {
    found.push(...openObjects(schema.items, `${where}[]`));
  }
  return found;
}

test("every object in the schema is closed and requires every field", () => {
  assert.deepEqual(openObjects(SPEC_WRITER_SCHEMA, "reply"), []);
  const fields = Object.keys(SPEC_WRITER_SCHEMA.properties ?? {});
  for (const name of Object.keys(SPEC_SCHEMA.properties ?? {})) {
    assert.ok(fields.includes(name), name);
  }
  assert.ok(fields.includes("interfaces"));
  assert.ok(fields.includes("noTestsReason"));
  const interfaces = propertiesOf(SPEC_WRITER_SCHEMA).get("interfaces");
  assert.deepEqual(Object.keys(interfaces?.items?.properties ?? {}), [
    "name",
    "kind",
    "where",
    "status",
    "signature",
    "behaviours",
  ]);
});

test("no-work is a decision of the role's schema but not of SPEC_SCHEMA", () => {
  assert.deepEqual(propertiesOf(SPEC_WRITER_SCHEMA).get("decision"), {
    enum: ["ready", "needs-info", "split", "no-work"],
  });
  assert.deepEqual(propertiesOf(SPEC_SCHEMA).get("decision"), {
    enum: ["ready", "needs-info", "split"],
  });
});

test("a whole ready reply reads as ready, without its end marker", () => {
  const reading = specReadingOf(replyOf(), 0);
  assert.equal(reading.kind, "ready");
  assert.ok(reading.kind === "ready");
  assert.equal(reading.reply.spec, SPEC);
});

test("a ready reading keeps its interfaces and noTestsReason", () => {
  const withInterfaces = specReadingOf(replyOf(), 0);
  assert.ok(withInterfaces.kind === "ready");
  assert.deepEqual(withInterfaces.reply.interfaces, [INTERFACE]);
  assert.equal(withInterfaces.reply.noTestsReason, null);
  const reason = "Only a wiki page changes.";
  const withReason = specReadingOf(
    replyOf({ interfaces: [], noTestsReason: reason }),
    0,
  );
  assert.ok(withReason.kind === "ready");
  assert.deepEqual(withReason.reply.interfaces, []);
  assert.equal(withReason.reply.noTestsReason, reason);
});

test("a spec without its end marker reads as a failed session", () => {
  for (const decision of ["ready", "needs-info", "split", "no-work"]) {
    const reading = specReadingOf(replyOf({ decision, spec: SPEC }), 0);
    assert.equal(reading.kind, "bad", decision);
  }
});

test("a reply that doesn't fit the schema reads as a failed session", () => {
  const { files: _files, ...noFiles } = replyOf();
  const malformed = [
    null,
    "a spec",
    noFiles,
    replyOf({ decision: "maybe" }),
    replyOf({ interfaces: [{ ...INTERFACE, kind: "class" }] }),
    replyOf({ noTestsReason: 3 }),
    replyOf({ extra: true }),
  ];
  for (const output of malformed) {
    const reading = specReadingOf(output, 0);
    assert.equal(reading.kind, "bad", JSON.stringify(output));
    assert.ok(reading.kind === "bad");
    assert.notEqual(reading.reason, "");
  }
});

test("a ready reply with no interfaces and no noTestsReason reads as a failed session", () => {
  const reading = specReadingOf(replyOf({ interfaces: [] }), 0);
  assert.equal(reading.kind, "bad");
});

test("needs-info with questions asks them, with the spec so far", () => {
  const questions = ["Which page?"];
  const reading = specReadingOf(
    replyOf({ decision: "needs-info", questions, interfaces: [] }),
    0,
  );
  assert.ok(reading.kind === "needs-info");
  assert.deepEqual(reading.reply.questions, questions);
  assert.equal(reading.reply.spec, SPEC);
});

test("needs-info without questions reads as ready", () => {
  const reading = specReadingOf(replyOf({ decision: "needs-info" }), 0);
  assert.equal(reading.kind, "ready");
  const bare = specReadingOf(
    replyOf({ decision: "needs-info", interfaces: [] }),
    0,
  );
  assert.equal(bare.kind, "bad");
});

test("a split of 2 parts at depth 0 reads as split", () => {
  const subIssues = [part("A"), part("B")];
  const reading = specReadingOf(replyOf({ decision: "split", subIssues }), 0);
  assert.ok(reading.kind === "split");
  assert.deepEqual(reading.reply.subIssues, subIssues);
});

test("a one-part split and a sub-issue's split are refused with their reasons", () => {
  const one = specReadingOf(
    replyOf({ decision: "split", subIssues: [part("A")] }),
    0,
  );
  assert.deepEqual(one, { kind: "refused", reason: SPLIT_TOO_SMALL });
  const nested = specReadingOf(
    replyOf({ decision: "split", subIssues: [part("A"), part("B")] }),
    1,
  );
  assert.deepEqual(nested, { kind: "refused", reason: SUB_ISSUE_SPLIT });
});

test("no-work reads as no-work, with its evidence", () => {
  const reading = specReadingOf(
    replyOf({ decision: "no-work", interfaces: [] }),
    0,
  );
  assert.ok(reading.kind === "no-work");
  assert.equal(reading.reply.spec, SPEC);
});
