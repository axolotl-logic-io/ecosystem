// @ts-check
// The findings an issue carries through its fix rounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addFinding,
  findingsStopCode,
  findingsStopReason,
  openFindings,
} from "../src/workflow/findings.ts";

const cfg = { maxFixRounds: 2 };
const BASE = "blocking findings remain after 2 fix rounds";
// How much of each field a stored finding keeps.
const FILE_LIMIT = 200;
const TITLE_LIMIT = 200;
const EVIDENCE_LIMIT = 600;
const SUGGESTION_LIMIT = 400;
// The last number an earlier sweep gave a finding.
const LAST_NUMBER = 6;

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

test("each field is clipped to its limit", () => {
  const long = {
    file: "f".repeat(FILE_LIMIT + 1),
    line: 1,
    title: "t".repeat(TITLE_LIMIT + 1),
    evidence: "e".repeat(EVIDENCE_LIMIT + 1),
    suggestion: "s".repeat(SUGGESTION_LIMIT + 1),
    category: "",
  };
  const finding = addFinding(emptyItem(), long, ["tests"]);
  assert.equal(finding.file, `${"f".repeat(FILE_LIMIT)}…`);
  assert.equal(finding.title, `${"t".repeat(TITLE_LIMIT)}…`);
  assert.equal(finding.evidence, `${"e".repeat(EVIDENCE_LIMIT)}…`);
  assert.equal(finding.suggestion, `${"s".repeat(SUGGESTION_LIMIT)}…`);
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
