// @ts-check
// The spec writer's interface coverage check (src/roles/spec-writer/
// coverage.ts, #331): the Behaviour items of a spec that no test interface
// quotes. A quote matches once trimmed with its whitespace collapsed, and is
// otherwise exact (the wiki's "Coverage check strictness").
import assert from "node:assert/strict";
import { test } from "node:test";
import { interfaceGaps } from "../src/roles/spec-writer/coverage.ts";

const SPEC = [
  "# Spec",
  "",
  "## Behaviour",
  "",
  "**Coverage**",
  "1. The check is pure: it reads",
  "   only its arguments.",
  "2. It returns the uncovered items.",
  "   - Nested items count too.",
  "* A starred item.",
  "+ A plus item.",
  "3) A parenthesised item.",
  "",
  "## Out of scope",
  "",
  "- Anything after Behaviour.",
].join("\n");
const ITEMS = [
  "The check is pure: it reads only its arguments.",
  "It returns the uncovered items.",
  "Nested items count too.",
  "A starred item.",
  "A plus item.",
  "A parenthesised item.",
];
// The items quoted with other whitespace and line wrapping.
const WRAPPED = [
  "  The check is pure:\n  it reads only\tits arguments.",
  "It returns the  uncovered items.",
  "Nested items count too.\n",
  "A starred item.",
  "A plus item.",
  "A parenthesised   item.",
];

test("every Behaviour item quoted, whitespace aside, leaves no gap", () => {
  const [first = "", ...rest] = WRAPPED;
  const interfaces = [{ behaviours: [first] }, { behaviours: rest }];
  assert.deepEqual(interfaceGaps(SPEC, interfaces), []);
});

test("an item quoted with other case is the one gap", () => {
  const behaviours = ITEMS.map((item) =>
    item.replace("A starred", "a starred"),
  );
  assert.deepEqual(interfaceGaps(SPEC, [{ behaviours }]), ["A starred item."]);
});

test("no interfaces leave every Behaviour item and none after it", () => {
  assert.deepEqual(interfaceGaps(SPEC, []), ITEMS);
});

test("a spec with a bold Behaviour label has its items read", () => {
  const spec = [
    "**Behaviour**",
    "- One item.",
    "- One item.",
    "- Another item.",
    "**Design**",
    "- A design note.",
  ].join("\n");
  assert.deepEqual(interfaceGaps(spec, [{ behaviours: ["Another item."] }]), [
    "One item.",
  ]);
});

test("a spec with no Behaviour section has no gaps", () => {
  assert.deepEqual(interfaceGaps("## Design\n\n- A note.", []), []);
});
