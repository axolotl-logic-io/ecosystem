// @ts-check
// The wiki's link rules (#215): which links in changed pages name no page,
// and which new pages nothing links to. Pure, over a hand-built WikiChange.
import assert from "node:assert/strict";
import { test } from "node:test";
import { wikiProblems } from "../src/wiki-check.ts";

/** @typedef {import("../src/wiki-check.ts").WikiChange} WikiChange */
/** @typedef {[file: string, text: string]} Edit */

/** @type {Edit[]} */
const BASE_PAGES = [
  ["Home.md", "Welcome. See [[Other Page]]."],
  ["_Sidebar.md", "- [[Home]]\n- [[Other Page]]"],
  ["Other-Page.md", "Back [[Home]]."],
];

// A change that adds or modifies `edits`, a list of [file, text]; `added`
// names which of them are new.
/**
 * @param {Edit[]} edits
 * @param {string[]} [added]
 * @returns {WikiChange}
 */
function change(edits, added = []) {
  return {
    pages: new Map([...BASE_PAGES, ...edits]),
    changed: edits.map(([file]) => file),
    added,
  };
}

test("links to missing pages are broken, once per target", () => {
  const text =
    "See [[Missing Page]] and [x](./Nope#a), and [[Missing Page]] again.";
  assert.deepEqual(wikiProblems(change([["Other-Page.md", text]])), [
    { kind: "broken-link", page: "Other-Page", target: "Missing Page" },
    { kind: "broken-link", page: "Other-Page", target: "Nope" },
  ]);
});

test("a new page nothing links to is an orphan, even if it links itself", () => {
  /** @type {Edit[]} */
  const edits = [["New-Page.md", "I am [[New Page]], see [t](New-Page.md)."]];
  assert.deepEqual(wikiProblems(change(edits, ["New-Page.md"])), [
    { kind: "orphan", page: "New-Page" },
  ]);
});

test("page links in any form, URLs and images are clean", () => {
  const text = [
    "[[Text|Other Page]] and [[Other-Page]]",
    "[t](Other-Page.md) and [t](./Other-Page#sec)",
    "[t](diagram.png)",
    "[site](https://example.com/Nope) [mail](mailto:a@b) [top](#top)",
    "[abs](/wiki/Nope) [img](pic.png) ![i](pic.png) ![i](Nope)",
  ].join("\n");
  assert.deepEqual(wikiProblems(change([["Home.md", text]])), []);
});

test("names match case-sensitively", () => {
  assert.deepEqual(wikiProblems(change([["Home.md", "[[other page]]"]])), [
    { kind: "broken-link", page: "Home", target: "other page" },
  ]);
});

test("a new page linked only from _Sidebar is not an orphan", () => {
  /** @type {Edit} */
  const sidebar = ["_Sidebar.md", "- [[Home]]\n- [[Brand New]]"];
  /** @type {Edit[]} */
  const edits = [sidebar, ["Brand-New.md", "Fresh."]];
  assert.deepEqual(wikiProblems(change(edits, ["Brand-New.md"])), []);
});

test("a new page linked only from a changed ordinary page is not an orphan", () => {
  /** @type {Edit[]} */
  const edits = [
    ["Home.md", "Welcome. See [[Brand New]]."],
    ["Brand-New.md", "Fresh."],
  ];
  assert.deepEqual(wikiProblems(change(edits, ["Brand-New.md"])), []);
});

test("a new page linked only from an unchanged page is not an orphan", () => {
  const pages = new Map([
    ...BASE_PAGES,
    ["Notes.md", "Read [[Brand New]]."],
    ["Brand-New.md", "Fresh."],
  ]);
  /** @type {WikiChange} */
  const linked = { pages, changed: ["Brand-New.md"], added: ["Brand-New.md"] };
  assert.deepEqual(wikiProblems(linked), []);
});

test("Home and the underscore pages are never orphans", () => {
  /** @type {Edit[]} */
  const edits = [
    ["sub/Home.md", "Home again."],
    ["_Footer.md", "Footer."],
  ];
  const added = ["sub/Home.md", "_Footer.md"];
  assert.deepEqual(wikiProblems(change(edits, added)), []);
});

test("code spans and fenced blocks hold no links, but prose after them does", () => {
  const text = [
    "Cite one as `[slug](Decisions-Area#slug)`",
    "or as ``[[Nope]]``, unlike [[Missing Inline]].",
    "```md",
    "[[Missing]] and [x](Nowhere)",
    "```",
    "~~~",
    "[[Also Missing]]",
    "~~~",
    "Back in prose: [[Missing After]].",
  ].join("\n");
  assert.deepEqual(wikiProblems(change([["Home.md", text]])), [
    { kind: "broken-link", page: "Home", target: "Missing Inline" },
    { kind: "broken-link", page: "Home", target: "Missing After" },
  ]);
});

test("broken links in unchanged pages are not checked", () => {
  const pages = new Map([...BASE_PAGES, ["Old.md", "[[Gone Page]]"]]);
  /** @type {WikiChange} */
  const linked = { pages, changed: ["Home.md"], added: [] };
  assert.deepEqual(wikiProblems(linked), []);
});
