// @ts-check
// The spec writer's draft PR text (#334): the body closes the issue, carries
// the spec's Behaviour section and links to the issue's `## Spec` comment,
// and the machine's open-pr state sends it to start-pr.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLE } from "../src/roles/spec-writer/machine.ts";
import { prBodyOf } from "../src/roles/spec-writer/pr.ts";
import { dataWith } from "./spec-writer-role-test-kit.mjs";

const SPEC = [
  "## Spec",
  "",
  "## Behaviour",
  "",
  "- The quota resets monthly.",
  "",
  "## Design",
  "",
  "- A cron job.",
].join("\n");
const ISSUE = 7;
const ISSUE_LINK = "https://github.com/o/r/issues/7";
const DESIGN = /A cron job/u;

test("the PR body closes the issue, then gives the Behaviour section, then links the spec comment", () => {
  const body = prBodyOf(ISSUE, "o/r", SPEC);
  const opening =
    "Closes #7\n\n## Behaviour\n\n- The quota resets monthly.\n\n";
  assert.ok(body.startsWith(opening), body);
  const link = body.slice(opening.length);
  assert.ok(link.includes(ISSUE_LINK), link);
  assert.ok(link.includes("## Spec"), link);
  assert.doesNotMatch(body, DESIGN);
});

test("open-pr sends start-pr with the body for the saved spec", () => {
  const effect = TABLE.states["open-pr"].effect(dataWith({ spec: SPEC }));
  assert.deepEqual(effect, {
    kind: "op",
    op: "start-pr",
    payload: { number: ISSUE, body: prBodyOf(ISSUE, "o/r", SPEC) },
  });
});
