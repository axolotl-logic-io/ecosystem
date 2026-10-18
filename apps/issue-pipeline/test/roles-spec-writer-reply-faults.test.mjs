// @ts-check
// What the spec writer's reply checks find in a reply
// (src/roles/spec-writer/reply-faults.ts): `check-reply`'s fault, which lists
// the uncovered Behaviour items whole and says how coverage matches, and the
// session's reply check's compact findings, which name each uncovered item
// by its number and the start of its text and add the commit check's
// git-only failures, so the session can fix them all before it ends.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readyFault,
  sessionFindings,
} from "../src/roles/spec-writer/reply-faults.ts";
import { INTERFACE, replyOf } from "./spec-writer-role-test-kit.mjs";

/** @import { Failure } from "../src/roles/spec-writer/check.ts" */

const SPEC_END = "<!-- end of spec -->";
const LEAD =
  "The pipeline's checks would fail this reply. Fix these, commit with pipeline_commit, then call structured_output again:";
const LONG_ITEM =
  "The second item is long enough that the compact finding shows only its start and no more of it.";
// A spec with three Behaviour items, the first with a sub-bullet.
const SPEC = [
  "## Behaviour",
  "",
  "- It works.",
  "  - Even nested.",
  `- ${LONG_ITEM}`,
  "- **Third.**",
  "",
  SPEC_END,
].join("\n");
/** @type {Failure} */
const SCOPE = {
  rule: "not-allowed",
  reason: "src/a.ts may not change: it is not a test file",
};

/** @param {readonly Failure[]} failures */
function gitFailures(failures) {
  /** @type {unknown[]} */
  const asked = [];
  /** @param {unknown} ready @returns {readonly Failure[]} */
  function failuresOf(ready) {
    asked.push(ready);
    return failures;
  }
  return { asked, failuresOf };
}

test("check-reply lists uncovered Behaviour items whole and says how coverage matches", () => {
  const reply = { spec: SPEC, interfaces: [INTERFACE], noTestsReason: null };
  assert.equal(
    readyFault(reply),
    [
      "No test interface quotes these Behaviour items in its behaviours:",
      `- ${LONG_ITEM}`,
      "- **Third.**",
      "An item is covered when one of an interface's `behaviours` quotes its own text, or its text with its sub-bullets; markdown and whitespace don't count.",
    ].join("\n"),
  );
});

test("the session's findings name uncovered items by number and start, then the git-only failures", () => {
  const { asked, failuresOf } = gitFailures([SCOPE]);
  const found = sessionFindings(replyOf({ spec: SPEC }), 0, failuresOf);
  const start = LONG_ITEM.slice(0, 60);
  assert.equal(
    found,
    [
      LEAD,
      `- coverage: no interface's \`behaviours\` quotes Behaviour items 2 ("${start}…"), 3 ("**Third.**"). An item is covered when one of an interface's \`behaviours\` quotes its own text, or its text with its sub-bullets; markdown and whitespace don't count.`,
      "- not-allowed: src/a.ts may not change: it is not a test file",
    ].join("\n"),
  );
  assert.equal(asked.length, 1);
});

test("a covered ready reply with no git-only failures has no findings", () => {
  const { failuresOf } = gitFailures([]);
  assert.equal(sessionFindings(replyOf(), 0, failuresOf), null);
});

test("a ready reply's git-only failures are findings on their own", () => {
  const { failuresOf } = gitFailures([SCOPE]);
  assert.equal(
    sessionFindings(replyOf(), 0, failuresOf),
    `${LEAD}\n- not-allowed: src/a.ts may not change: it is not a test file`,
  );
});

test("a reply the role reads as bad is a finding, and git is not asked", () => {
  const { asked, failuresOf } = gitFailures([SCOPE]);
  const found = sessionFindings(
    replyOf({ spec: "## Behaviour" }),
    0,
    failuresOf,
  );
  assert.ok(found?.startsWith(`${LEAD}\n- the spec doesn't end with`));
  assert.deepEqual(asked, []);
});

test("a handoff or a reply that isn't ready has no findings", () => {
  const { asked, failuresOf } = gitFailures([SCOPE]);
  const handoff = { status: "handoff", summary: "Half done." };
  const noWork = replyOf({ decision: "no-work" });
  assert.equal(sessionFindings(handoff, 0, failuresOf), null);
  assert.equal(sessionFindings(noWork, 0, failuresOf), null);
  assert.deepEqual(asked, []);
});
