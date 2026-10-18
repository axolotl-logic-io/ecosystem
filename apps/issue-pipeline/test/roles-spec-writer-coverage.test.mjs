// @ts-check
// The spec writer's interface coverage check (src/roles/spec-writer/
// coverage.ts, #331): the Behaviour items of a spec that no test interface
// quotes. Nested sub-bullets fold into their parent item, and a quote matches
// once markdown and whitespace are stripped from it and the item; it is
// otherwise exact (the wiki's "Coverage check strictness").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  behaviourGaps,
  interfaceGaps,
} from "../src/roles/spec-writer/coverage.ts";

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
  "A starred item.",
  "A plus item.",
  "A parenthesised item.",
];
// The items quoted with other whitespace and line wrapping.
const WRAPPED = [
  "  The check is pure:\n  it reads only\tits arguments.",
  "It returns the  uncovered items.\n",
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

test("quoting a parent item covers its nested sub-bullets", () => {
  // ITEMS quotes "It returns the uncovered items." but not its sub-bullet.
  assert.deepEqual(interfaceGaps(SPEC, [{ behaviours: ITEMS }]), []);
});

test("quoting a parent item with its sub-bullets covers it too", () => {
  const behaviours = ITEMS.map((item) => {
    if (item === "It returns the uncovered items.") {
      return "It returns the uncovered items. Nested items count too.";
    }
    return item;
  });
  assert.deepEqual(interfaceGaps(SPEC, [{ behaviours }]), []);
});

test("quoting only a sub-bullet leaves its parent a gap", () => {
  const behaviours = ITEMS.map((item) => {
    if (item === "It returns the uncovered items.") {
      return "Nested items count too.";
    }
    return item;
  });
  assert.deepEqual(interfaceGaps(SPEC, [{ behaviours }]), [
    "It returns the uncovered items.",
  ]);
});

test("markdown and whitespace in the item or the quote don't matter", () => {
  const spec = [
    "## Behaviour",
    "",
    "- **Layout.** The `--plain` flag prints [the table](https://example.com/t) as _text_.",
    "  - Each row is one line.",
    "- ~~Old~~ rows stay.",
  ].join("\n");
  const behaviours = [
    "Layout. The --plain flag prints the table as text.",
    "**Old** rows  stay.",
  ];
  assert.deepEqual(interfaceGaps(spec, [{ behaviours }]), []);
  assert.deepEqual(
    interfaceGaps(spec, [
      { behaviours: ["Layout. The --plain flag prints the table."] },
    ]),
    [
      "**Layout.** The `--plain` flag prints [the table](https://example.com/t) as _text_.",
      "~~Old~~ rows stay.",
    ],
  );
});

test("each gap carries its item's number among the top-level items", () => {
  const behaviours = ["It returns the uncovered items.", "A plus item."];
  assert.deepEqual(behaviourGaps(SPEC, [{ behaviours }]), [
    { number: 1, text: "The check is pure: it reads only its arguments." },
    { number: 3, text: "A starred item." },
    { number: 5, text: "A parenthesised item." },
  ]);
});
