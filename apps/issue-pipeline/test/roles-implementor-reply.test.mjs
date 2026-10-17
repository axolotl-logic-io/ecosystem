// @ts-check
// The implementor's implementer reply (#414): the role's IMPL_SCHEMA keeps
// only `status` and `summary` (`tests-added-derived`,
// `spec-writer-opens-pr`), and the reader still reads a reply that carries
// today's `testsAdded`, `prTitle` and `prBody`, or the job's hard-limit
// handoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPL_SCHEMA, implReadingOf } from "../src/roles/implementor/reply.ts";
import {
  BLOCKED,
  DONE,
  HANDOFF,
  HARD_LIMIT_HANDOFF,
  OLD_DONE,
  stepFrom,
} from "./implementor-role-test-kit.mjs";

// The only fields of the role's implementer reply.
const FIELDS = new Set(["status", "summary"]);

test("the role's IMPL_SCHEMA is closed and has only status and summary", () => {
  assert.equal(IMPL_SCHEMA.type, "object");
  assert.equal(IMPL_SCHEMA.additionalProperties, false);
  const { properties = {}, required = [] } = IMPL_SCHEMA;
  assert.deepEqual(new Set(Object.keys(properties)), FIELDS);
  assert.deepEqual(new Set(required), FIELDS);
  const { status = {} } = properties;
  assert.deepEqual(status.enum, ["done", "handoff", "blocked"]);
});

test("each status reads as its status and summary", () => {
  for (const reply of [DONE, HANDOFF, BLOCKED]) {
    assert.deepEqual(implReadingOf(reply), reply);
  }
});

test("a reply with testsAdded, prTitle or prBody still reads, without them", () => {
  assert.deepEqual(implReadingOf(OLD_DONE), DONE);
  for (const field of ["testsAdded", "prTitle", "prBody"]) {
    const reply = { ...DONE, [field]: Reflect.get(OLD_DONE, field) };
    assert.deepEqual(implReadingOf(reply), DONE, field);
  }
  const { summary } = HARD_LIMIT_HANDOFF;
  assert.deepEqual(implReadingOf(HARD_LIMIT_HANDOFF), {
    status: "handoff",
    summary,
  });
});

test("a reply without a known status or a summary doesn't read", () => {
  for (const reply of [
    null,
    "done",
    {},
    { status: "finished", summary: "x" },
    { status: "done" },
    { status: "done", summary: 3 },
  ]) {
    assert.equal(implReadingOf(reply), null, JSON.stringify(reply));
  }
});

test("the implementer's reply with today's fields routes as done", () => {
  const read = stepFrom("implementer", "replied", OLD_DONE);
  assert.deepEqual(read.state.data.reply, DONE);
  const step = stepFrom("implementer-reply", "done", null, { reply: DONE });
  assert.equal(step.state.at, "flows");
});
