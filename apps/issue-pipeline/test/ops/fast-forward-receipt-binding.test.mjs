// @ts-check
// Authenticated synthetic snapshots exercise the preservation boundary, not
// a claim that head equality can establish a new delivery receipt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { calls, consumed, script } from "../explicit-target-test-kit.mjs";
import {
  BASE,
  BRANCH,
  git,
  ISSUE,
  PR,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import {
  confirmation,
  retainLegacyAttempt,
} from "./explicit-target-recovery-test-kit.mjs";

const { readWriteState, stateBody } = await import("../../src/saved-state.ts");
const { reconcileMerge } = await import("../../src/ops/merge-recovery.ts");
const { release, saveState } = await import("../../src/ops/save-state.ts");
const TWO_PARENT_COMMIT_AND_PARENTS = 3;
const INTENT = /intent|authorization|bound intended operation|work is on/u;
/** @typedef {import("../../src/state.ts").IssueState} IssueState */
/** @typedef {import("../explicit-target-world-test-kit.mjs").World} World */

/** @typedef {import("../../src/state.ts").MergeAttempt} MergeAttempt */
/** @param {World} w @returns {{saved: IssueState, attempt: MergeAttempt}} */
function receiptSnapshot(w) {
  /** @type {MergeAttempt} */
  const attempt = {
    repo: w.cfg.repo,
    pr: PR,
    target: BASE,
    branch: BRANCH,
    authorized: w.revision,
    hardened: w.revision,
    integration: null,
    operation: { kind: "fast-forward", base: w.base },
    result: null,
    reads: 1,
  };
  return {
    attempt,
    saved: {
      ...w.state,
      codeMerged: { pr: PR, sha: w.head },
      merged: w.revision,
      mergeAttempt: attempt,
    },
  };
}

/** @param {World} w @param {MergeAttempt} attempt @param {string} defect @returns {boolean} */
function changeAttempt(w, attempt, defect) {
  switch (defect) {
    case "repo":
      attempt.repo = "other/repo";
      break;
    case "target":
      attempt.target = "main";
      break;
    case "attempt branch":
      attempt.branch = "other";
      break;
    case "PR":
      attempt.pr += 1;
      break;
    case "result":
      attempt.result = w.moved;
      break;
    case "authorized code":
      attempt.authorized = { ...w.revision, code: w.moved };
      break;
    case "base":
      attempt.operation = { kind: "fast-forward", base: w.moved };
      break;
    default:
      return false;
  }
  return true;
}

/** @param {World} w @param {IssueState} saved @param {string} defect @returns {boolean} */
function changeReceipt(w, saved, defect) {
  switch (defect) {
    case "saved branch":
      saved.branch = "other";
      break;
    case "receipt inputs":
      saved.merged = { ...w.revision, inputs: "changed" };
      break;
    case "receipt wiki":
      saved.merged = { ...w.revision, wiki: w.moved };
      break;
    case "hardening":
      saved.hardened = { ...w.revision, code: w.moved };
      break;
    case "integration":
      saved.integration = { reviewed: w.revision, revision: w.revision };
      break;
    case "landed PR":
      saved.codeMerged = { pr: PR + 1, sha: w.head };
      break;
    case "missing landed fact":
      saved.codeMerged = null;
      break;
    default:
      return false;
  }
  return true;
}

/** @param {World} w @param {IssueState} state */
function retain(w, state) {
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  script(w, []);
}

for (const mode of ["equal heads", "armed only", "landed fact"]) {
  test(`${mode} without a saved confirmed receipt cannot manufacture one on stale save`, () => {
    const w = world({ fastForward: true });
    const { saved } = receiptSnapshot(w);
    saved.merged = null;
    if (mode === "equal heads") {
      saved.mergeAttempt = null;
    }
    if (mode === "armed only") {
      saved.codeMerged = null;
    }
    git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.head]);
    retain(w, saved);
    saveState(w.cfg, { number: ISSUE, state: w.state });
    const written = readWriteState(w.cfg, ISSUE);
    assert.equal(written.merged, null);
    assert.ok(saved.security !== null);
    assert.equal(saved.security.phase, "candidate");
    assert.deepEqual(written.security, saved.security);
    assert.deepEqual(written.mergeAttempt, saved.mergeAttempt);
    assert.deepEqual(written.codeMerged, saved.codeMerged);
    consumed();
  });
}

for (const defect of [
  "repo",
  "target",
  "attempt branch",
  "saved branch",
  "PR",
  "result",
  "authorized code",
  "receipt inputs",
  "receipt wiki",
  "base",
  "hardening",
  "integration",
  "landed PR",
  "missing landed fact",
]) {
  test(`stale save refuses a saved FF receipt with changed ${defect}, without erasing evidence`, () => {
    const w = world({ fastForward: true });
    const { saved, attempt } = receiptSnapshot(w);
    if (
      !(changeAttempt(w, attempt, defect) || changeReceipt(w, saved, defect))
    ) {
      throw new Error(`unknown receipt defect ${defect}`);
    }
    retain(w, saved);
    assert.throws(
      () => saveState(w.cfg, { number: ISSUE, state: w.state }),
      INTENT,
    );
    assert.deepEqual(readWriteState(w.cfg, ISSUE), saved);
    assert.equal(
      calls().some((args) => args.includes("PATCH")),
      false,
    );
    consumed();
  });
}

for (const finding of [
  null,
  {
    category: /** @type {const} */ ("rights"),
    reason: "legacy result rejected",
  },
]) {
  test(`genuine historical two-parent response receipt survives stale save and release: ${JSON.stringify(finding)}`, () => {
    const w = world({ concurrent: true });
    retainLegacyAttempt(w);
    script(w, confirmation(w));
    assert.equal(
      reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()).merged,
      true,
    );
    const confirmed = readWriteState(w.cfg, ISSUE);
    assert.equal(confirmed.mergeAttempt?.operation, undefined);
    assert.equal(confirmed.mergeAttempt?.result, w.merged);
    assert.equal(confirmed.merged?.code, w.merged);
    assert.notEqual(w.merged, w.head);
    assert.equal(
      git(w.wt, ["rev-list", "--parents", "-n", "1", w.merged]).split(" ")
        .length,
      TWO_PARENT_COMMIT_AND_PARENTS,
    );
    const security = {
      revision: { ...w.revision, code: w.merged },
      commentId: PR,
      finding,
    };
    saveState(w.cfg, { number: ISSUE, state: { ...confirmed, security } });
    saveState(w.cfg, { number: ISSUE, state: w.state });
    release(w.cfg, {
      number: ISSUE,
      state: w.state,
      lane: "legacy",
      sweepId: "stale",
    });
    const retained = readWriteState(w.cfg, ISSUE);
    assert.deepEqual(retained.merged, confirmed.merged);
    assert.deepEqual(retained.security, security);
    assert.deepEqual(retained.mergeAttempt, confirmed.mergeAttempt);
    assert.deepEqual(retained.codeMerged, confirmed.codeMerged);
    consumed();
  });
}

test("a historical attempt without response evidence does not gain FF receipt preservation", () => {
  const w = world({ concurrent: true });
  retainLegacyAttempt(w, null);
  script(w, []);
  const attempt = readWriteState(w.cfg, ISSUE).mergeAttempt;
  retain(w, {
    ...w.state,
    mergeAttempt: attempt,
    merged: { ...w.revision, code: w.merged },
  });
  saveState(w.cfg, { number: ISSUE, state: w.state });
  const retained = readWriteState(w.cfg, ISSUE);
  assert.equal(retained.merged, null);
  assert.equal(retained.mergeAttempt?.result, null);
  assert.equal(retained.mergeAttempt?.operation, undefined);
  consumed();
});
