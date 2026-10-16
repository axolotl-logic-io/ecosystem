// @ts-check
// The findings an issue carries through its fix rounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceDisputeStop,
  addFinding,
  findingsStopCode,
  findingsStopReason,
  openFindings,
} from "../src/workflow/findings.ts";

const cfg = { maxFixRounds: 2 };
const BASE = "blocking findings remain after 2 fix rounds";
// A field far longer than a stored finding keeps.
const LONG_FIELD = 10_000;
// The last number an earlier sweep gave a finding.
const LAST_NUMBER = 6;
// The titles of two acceptance findings, as a stop's detail shows them.
const FIRST_ITEM = /Spec item 1/u;
const SECOND_ITEM = /Spec item 2/u;

const reported = {
  file: "src/a.ts",
  line: 12,
  title: "Off by one",
  evidence: "The loop stops early.",
  suggestion: "Use <=.",
};

/**
 * An issue's findings as addFinding reads and writes them.
 * @typedef {Parameters<typeof addFinding>[0]} FindingsItem
 */

/** @returns {FindingsItem} */
function emptyItem() {
  return { st: { findings: [] } };
}

test("findings are numbered f1, f2 and stored open", () => {
  const item = emptyItem();
  const first = addFinding(item, reported, ["correctness"]);
  const second = addFinding(item, { ...reported, category: "rights" }, [
    "security",
  ]);
  assert.deepEqual(first, {
    id: "f1",
    ...reported,
    lenses: ["correctness"],
    category: null,
    status: "open",
    disputed: false,
  });
  assert.equal(second.id, "f2");
  assert.equal(second.category, "rights");
  assert.equal(item.st.nextFindingId, 2);
  assert.deepEqual(item.st.findings, [first, second]);
});

test("the stored finding is the one returned", () => {
  const item = emptyItem();
  const finding = addFinding(item, reported, ["tests"]);
  finding.status = "resolved";
  const [stored] = item.st.findings;
  assert.equal(stored?.status, "resolved");
});

test("numbering continues from the state", () => {
  const item = { st: { findings: [], nextFindingId: LAST_NUMBER } };
  assert.equal(addFinding(item, reported, ["scope"]).id, "f7");
});

// `text` repeated to `length` characters, so a clipped copy keeps a
// prefix that differs from field to field.
/** @param {string} text @param {number} length @returns {string} */
function longText(text, length) {
  return text.repeat(Math.ceil(length / text.length)).slice(0, length);
}

test("each over-long field is clipped with an ellipsis", () => {
  const long = {
    file: longText("src/file-", LONG_FIELD),
    line: 1,
    title: longText("title ", LONG_FIELD),
    evidence: longText("evidence ", LONG_FIELD),
    suggestion: longText("suggestion ", LONG_FIELD),
    category: "",
  };
  const finding = addFinding(emptyItem(), long, ["tests"]);
  for (const field of /** @type {const} */ ([
    "file",
    "title",
    "evidence",
    "suggestion",
  ])) {
    const stored = finding[field];
    assert.ok(stored.length < long[field].length, field);
    assert.ok(stored.endsWith("…"), field);
    assert.ok(long[field].startsWith(stored.slice(0, -1)), field);
  }
  assert.equal(finding.category, null);
});

test("open findings are those still open", () => {
  const item = emptyItem();
  const open = addFinding(item, reported, ["tests"]);
  addFinding(item, reported, ["tests"]).status = "resolved";
  assert.deepEqual(openFindings(item), [open]);
});

test("open findings with no security category stop with the base reason", () => {
  const item = emptyItem();
  addFinding(item, reported, ["correctness"]);
  assert.equal(findingsStopCode(item), null);
  assert.equal(findingsStopReason(cfg, item, BASE), BASE);
});

test("an open security finding names the stop and its reason", () => {
  const item = emptyItem();
  addFinding(item, reported, ["correctness"]);
  addFinding(
    item,
    { ...reported, title: "Leaks data", category: "user-harm" },
    ["security"],
  );
  assert.equal(findingsStopCode(item), "user-harm");
  assert.equal(
    findingsStopReason(cfg, item, BASE),
    "security review (user-harm): Leaks data is still open after 2 fix rounds",
  );
});

test("a resolved security finding doesn't name the stop", () => {
  const item = emptyItem();
  addFinding(item, { ...reported, category: "rights" }, ["security"]).status =
    "resolved";
  addFinding(item, reported, ["tests"]);
  assert.equal(findingsStopCode(item), null);
  assert.equal(findingsStopReason(cfg, item, BASE), BASE);
});

test("a dispute of any open acceptance finding stops with that finding", () => {
  const item = emptyItem();
  addFinding(item, { ...reported, title: "Spec item 1" }, ["acceptance"]);
  addFinding(item, { ...reported, title: "Spec item 2" }, [
    "acceptance",
  ]).disputed = true;
  const stop = acceptanceDisputeStop(item);
  assert.equal(stop?.code, "acceptance");
  assert.equal(
    stop?.reason,
    "the acceptance verifier found the issue is not fully resolved",
  );
  assert.match(stop?.detail ?? "", SECOND_ITEM);
  assert.doesNotMatch(stop?.detail ?? "", FIRST_ITEM);
});

test("open acceptance findings no one disputed don't stop", () => {
  const item = emptyItem();
  addFinding(item, reported, ["acceptance"]);
  addFinding(item, reported, ["correctness"]).disputed = true;
  assert.equal(acceptanceDisputeStop(item), null);
});
