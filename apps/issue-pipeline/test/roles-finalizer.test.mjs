// @ts-check
// The finalizer role runs the merge stage (#416), on the role runner with
// fake ops: the open-findings gate, the merge at the verified head in merge
// order with the orchestrator's queue, a change that lives only in the wiki,
// and what each merge reply does to the issue, as today's merge stage does
// (src/workflow/stages/merge.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  finalize,
  MERGED_LABEL,
  prMerges,
  sentTo,
  VERIFIED,
} from "./finalizer-role-test-kit.mjs";

const QUEUED = {
  merged: false,
  reason: "queued",
  waitingFor: 9,
  waitingForPr: 40,
};
// The orchestrator's merge queue: issues ranked ahead of #7.
const AHEAD = 3;
const NEXT = 5;
const QUEUE = [AHEAD, NEXT];
const SRC = path.join(import.meta.dirname, "..", "src");
const FINALIZER_DIR = path.join(SRC, "roles", "finalizer");
const IMPORT_FROM = /from "(?<spec>[^"]+)"/gu;
// The sweep's merge-stage modules, which build the sweep's steps: the role
// takes their rules, not their steps.
const SWEEP_STEP_MODULES = [
  "merge.ts",
  "merge-wiki.ts",
  "sync-conflict.ts",
  "publish.ts",
];
const WAIT_NOTE = "merge waits for #9 (older PR #40)";
const REFUSED = "GitHub refused the merge";
const NETWORK_DOWN = "Could not resolve host: api.github.com";
const CHECKS_SUMMARY = /tests pass/u;
const DEFERRED = /merge deferred/u;
// An open finding from the acceptance check.
const ACCEPTANCE_FINDING = {
  id: "a1",
  file: "src/a.ts",
  line: 1,
  title: "It doesn't do the thing.",
  evidence: "",
  suggestion: "",
  lenses: ["acceptance"],
  category: null,
  status: "open",
  disputed: false,
};

/** @param {unknown} log @param {string} note @returns {number} the log's lines that hold `note` */
function linesWith(log, note) {
  if (!Array.isArray(log)) {
    return 0;
  }
  return log.filter((line) => String(line).includes(note)).length;
}

test("a clean merge merges once at the verified head in merge order and saves the issue at done", async () => {
  const run = await finalize();
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  const { stage, lease } = run.saved;
  assert.equal(stage, "done");
  assert.equal(lease, null);
  assert.deepEqual(run.labels, [MERGED_LABEL]);
  assert.equal(prMerges(run.writes), 1);
  const [payload = {}, ...more] = sentTo(run, "merge");
  assert.deepEqual(more, []);
  const { expectedSha, mergeOrder, summary } = payload;
  assert.equal(expectedSha, VERIFIED);
  assert.equal(mergeOrder, true);
  assert.match(String(summary), CHECKS_SUMMARY);
  assert.equal(Object.hasOwn(payload, "mergeQueue"), false);
});

test("the merge waits on the orchestrator's merge queue when it passes one", async () => {
  const run = await finalize({ mergeQueue: QUEUE });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  const [{ mergeQueue } = {}] = sentTo(run, "merge");
  assert.deepEqual(mergeQueue, QUEUE);
});

test("a merge whose wiki changes weren't published saves the issue at publish", async () => {
  const run = await finalize({ published: false });
  assert.deepEqual(run.end, { kind: "saved", stage: "publish" });
  const { stage } = run.saved;
  assert.equal(stage, "publish");
  assert.deepEqual(run.labels, [MERGED_LABEL]);
});

test("a queued merge ends held at merge, and its wait is logged once", async () => {
  const first = await finalize({ merge: QUEUED });
  assert.deepEqual(first.end, { kind: "held" });
  const { stage, log } = first.saved;
  assert.equal(stage, "merge");
  assert.equal(linesWith(log, WAIT_NOTE), 1);
  assert.deepEqual(first.labels, []);
  const again = await finalize({ merge: QUEUED, start: { log } });
  assert.deepEqual(again.end, { kind: "held" });
  assert.equal(linesWith(again.saved.log, WAIT_NOTE), 1);
});

for (const reason of ["behind", "conflict"]) {
  test(`a ${reason} merge saves the issue at sync with its passed head kept`, async () => {
    const run = await finalize({ merge: { merged: false, reason } });
    assert.deepEqual(run.end, { kind: "saved", stage: "sync" });
    const { stage, passedSha, log } = run.saved;
    assert.equal(stage, "sync");
    assert.equal(passedSha, VERIFIED);
    assert.equal(linesWith(log, reason) > 0, true);
    assert.match(String(log), DEFERRED);
    assert.equal(prMerges(run.writes), 0);
    assert.deepEqual(run.labels, []);
  });
}

test("a merge GitHub refuses stops the issue with merge-refused", async () => {
  const run = await finalize({
    merge: { merged: false, reason: "PR is CLOSED" },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "merge-refused" });
  const { stage, stopReason } = run.saved;
  assert.equal(stage, "stopped");
  assert.equal(stopReason, REFUSED);
  assert.deepEqual(run.labels, ["agent:stopped-merge-refused"]);
});

test("a merge that fails on the network ends held at merge", async () => {
  const run = await finalize({ mergeError: NETWORK_DOWN });
  assert.deepEqual(run.end, { kind: "held" });
  const { stage } = run.saved;
  assert.equal(stage, "merge");
  assert.deepEqual(run.labels, []);
});

test("a merge that fails otherwise stops the issue", async () => {
  const run = await finalize({ mergeError: "gh: something broke" });
  assert.deepEqual(run.end, { kind: "stopped", code: "error" });
  assert.deepEqual(run.labels, ["agent:stopped-error"]);
});

test("an open blocking finding stops the issue with its code and merges nothing", async () => {
  const run = await finalize({ start: { findings: [ACCEPTANCE_FINDING] } });
  assert.deepEqual(run.end, { kind: "stopped", code: "acceptance" });
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.equal(prMerges(run.writes), 0);
  assert.deepEqual(run.labels, ["agent:stopped-acceptance"]);
});

test("a change that lives only in the wiki is finished by finish-wiki, with no merge", async () => {
  const flows = { code: false, wiki: true };
  const run = await finalize({ wiki: true, start: { flows } });
  assert.deepEqual(run.end, { kind: "saved", stage: "done" });
  assert.equal(sentTo(run, "finish-wiki").length, 1);
  assert.deepEqual(sentTo(run, "merge"), []);
  assert.equal(prMerges(run.writes), 0);
  assert.deepEqual(run.labels, [MERGED_LABEL]);
});

/** @param {string} file @returns {string} why one of its imports is another role's or a sweep step module, or "" */
function foreignImport(file) {
  const found = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_FROM)) {
    const { spec } = match.groups ?? {};
    const target = path.resolve(path.dirname(file), spec ?? "");
    const fromSrc = path.relative(SRC, target).split(path.sep);
    const [top, sub, leaf] = fromSrc;
    const otherRole =
      top === "roles" && fromSrc.length > 2 && sub !== "finalizer";
    const sweepStep =
      top === "workflow" &&
      sub === "stages" &&
      SWEEP_STEP_MODULES.includes(String(leaf));
    if (otherRole || sweepStep) {
      found.push(`${path.basename(file)} imports ${fromSrc.join("/")}`);
    }
  }
  return found.join("; ");
}

test("the finalizer role imports no other role's modules and none of the sweep's merge steps", () => {
  const files = readdirSync(FINALIZER_DIR, { encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(FINALIZER_DIR, file));
  assert.ok(files.length > 0);
  assert.deepEqual(files.map(foreignImport).filter(Boolean), []);
});
