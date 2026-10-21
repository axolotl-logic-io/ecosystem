// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import { retainLegacyAttempt } from "./explicit-target-recovery-test-kit.mjs";
import {
  calls,
  consumed,
  mergedView,
  prStep,
  script,
} from "./explicit-target-test-kit.mjs";
import {
  BASE,
  BRANCH,
  git,
  ISSUE,
  PR,
  world,
} from "./explicit-target-world-test-kit.mjs";

const { reconcileMerge } = await import("../src/ops/merge-recovery.ts");
const { mergedCode } = await import("../src/ops/merged-review.ts");
const { verify } = await import("../src/ops/verify.ts");
const { readWriteState, stateBody } = await import("../src/saved-state.ts");
const { mergedParent } = await import("../src/ops/merged-graph.ts");
const UNSUPPORTED = /unsupported merged result/u;
const REFUSED = z.looseObject({ merged: z.literal(false), reason: z.string() });

/** @param {import("./explicit-target-world-test-kit.mjs").World} w */
function receiptSteps(w) {
  return [prStep(w, mergedView(w), true), prStep(w, mergedView(w), true)];
}
/** @returns {string[][]} */
function mutations() {
  return calls().filter(
    (args) => args.includes("POST") && !args.includes("event=APPROVE"),
  );
}

test("fast-forward multi-commit H requires authenticated exact intent and checks/review include all original commits", () => {
  const w = world({ fastForward: true });
  git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.head]);
  script(w, receiptSteps(w));
  assert.throws(
    () => verify(w.cfg, { number: ISSUE, codeMerged: { pr: PR, sha: w.head } }),
    UNSUPPORTED,
  );
  consumed();
  const state = {
    ...w.state,
    codeMerged: { pr: PR, sha: w.head },
    merged: w.revision,
    mergeAttempt: {
      repo: w.cfg.repo,
      pr: PR,
      target: BASE,
      branch: BRANCH,
      authorized: w.revision,
      hardened: w.revision,
      integration: null,
      operation: { kind: /** @type {const} */ ("fast-forward"), base: w.base },
      result: null,
      reads: 1,
    },
  };
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  script(w, receiptSteps(w));
  const verified = verify(w.cfg, {
    number: ISSUE,
    codeMerged: state.codeMerged,
  });
  assert.equal(verified.pass, true);
  assert.deepEqual(verified.changedFiles, ["early.txt", "late.txt"]);
  consumed();
  script(w, receiptSteps(w));
  const reviewed = mergedCode(w.cfg, ISSUE, state.codeMerged);
  assert.deepEqual(reviewed.range, { from: w.base, head: w.head });
  assert.deepEqual(reviewed.files, ["early.txt", "late.txt"]);
  assert.ok(reviewed.diff.includes("earlier feature commit"));
  assert.ok(reviewed.diff.includes("last feature commit"));
  assert.equal(mutations().length, 0);
  consumed();
});

test("legacy genuine squash retains complete original-head delta and rejects partial delta", () => {
  const w = world({ squash: true });
  assert.equal(mergedParent(w.wt, w.merged, w.head), w.parent);
  assert.throws(() => mergedParent(w.wt, w.merged, w.head, true), UNSUPPORTED);
  // A fake one-parent receipt covering only the final feature commit must
  // not silently stand in for the earlier feature contribution.
  git(w.seed, ["checkout", "-q", "--detach", w.base]);
  fs.writeFileSync(path.join(w.seed, "late.txt"), "last feature commit\n");
  git(w.seed, ["add", "late.txt"]);
  git(w.seed, ["commit", "-qm", "partial"]);
  const partial = git(w.seed, ["rev-parse", "HEAD"]);
  git(w.seed, ["push", "-q", "origin", `${partial}:refs/heads/partial`]);
  git(w.wt, ["fetch", "-q", "origin", "partial"]);
  assert.throws(() => mergedParent(w.wt, partial, w.head), UNSUPPORTED);
});

for (const shape of ["reversed", "octopus"]) {
  test(`${shape} parents stop on 201 and on recovered merged checks`, () => {
    const w = world();
    const tree = git(w.seed, ["rev-parse", `${w.merged}^{tree}`]);
    let parents = ["-p", w.head, "-p", w.parent];
    if (shape === "octopus") {
      parents = ["-p", w.parent, "-p", w.head, "-p", w.moved];
    }
    const sha = git(w.seed, ["commit-tree", tree, ...parents, "-m", shape]);
    git(w.seed, ["push", "-q", "origin", `${sha}:refs/heads/unsupported`]);
    const unsupported = { ...w, merged: sha };
    retainLegacyAttempt(unsupported);
    script(w, [
      ...Array.from({ length: 3 }, () => [
        prStep(unsupported, mergedView(unsupported)),
        prStep(unsupported, mergedView(unsupported), true),
      ]).flat(),
    ]);
    assert.match(
      REFUSED.parse(
        reconcileMerge(w.cfg, { number: ISSUE }, confirmationClock()),
      ).reason,
      UNSUPPORTED,
    );
    assert.equal(git(w.origin, ["rev-parse", BASE]), sha);
    consumed();
    script(w, receiptSteps(unsupported));
    assert.throws(
      () => verify(w.cfg, { number: ISSUE, codeMerged: { pr: PR, sha } }),
      UNSUPPORTED,
    );
    assert.equal(mutations().length, 0);
    consumed();
  });
}

test("genuine legacy squash can still prepare a full multi-commit security delta and verify M", () => {
  const w = world({ squash: true });
  git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.merged]);
  script(w, receiptSteps(w));
  const checked = verify(w.cfg, {
    number: ISSUE,
    codeMerged: { pr: PR, sha: w.merged },
  });
  assert.equal(checked.pass, true);
  assert.equal(checked.headSha, w.merged);
  assert.deepEqual(checked.changedFiles, ["early.txt", "late.txt"]);
  consumed();
  script(w, receiptSteps(w));
  const reviewed = mergedCode(w.cfg, ISSUE, { pr: PR, sha: w.merged });
  assert.deepEqual(reviewed.files, ["early.txt", "late.txt"]);
  assert.ok(reviewed.diff.includes("earlier feature commit"));
  assert.ok(reviewed.diff.includes("last feature commit"));
  assert.equal(mutations().length, 0);
  consumed();
});

/** @param {import("./explicit-target-world-test-kit.mjs").World} w @param {string} tree @param {string} label @param {string[]} parents */
function graphNode(w, tree, label, ...parents) {
  return git(w.seed, [
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    label,
  ]);
}

// Genuine criss-cross objects have two distinct best common ancestors.
function crissCross() {
  const w = world();
  const tree = git(w.seed, ["rev-parse", `${w.head}^{tree}`]);
  const left = graphNode(w, tree, "left", w.base);
  const right = graphNode(w, tree, "right", w.base);
  const parent = graphNode(w, tree, "parent", left, right);
  const head = graphNode(w, tree, "head", right, left);
  const merged = graphNode(w, tree, "ambiguous", parent, head);
  const revision = { ...w.revision, code: head };
  const state = {
    ...w.state,
    hardened: revision,
    headSha: head,
    verifiedSha: head,
  };
  const ambiguous = { ...w, head, merged, parent, revision, state };
  git(w.seed, [
    "push",
    "-q",
    "origin",
    `${merged}:refs/heads/ambiguous`,
    `+${head}:refs/heads/${BRANCH}`,
  ]);
  git(w.wt, ["fetch", "-q", "origin"]);
  git(w.wt, ["checkout", "-q", "--detach", head]);
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  return ambiguous;
}

test("ambiguous criss-cross history retains landed truth but cannot establish own provenance", () => {
  const ambiguous = crissCross();
  const { cfg, merged } = ambiguous;
  retainLegacyAttempt(ambiguous);
  script(ambiguous, [
    ...Array.from({ length: 3 }, () => [
      prStep(ambiguous, mergedView(ambiguous)),
      prStep(ambiguous, mergedView(ambiguous), true),
    ]).flat(),
  ]);
  assert.match(
    REFUSED.parse(reconcileMerge(cfg, { number: ISSUE }, confirmationClock()))
      .reason,
    UNSUPPORTED,
  );
  assert.deepEqual(readWriteState(cfg, ISSUE).codeMerged, {
    pr: PR,
    sha: merged,
  });
  assert.equal(readWriteState(cfg, ISSUE).merged, null);
  assert.equal(mutations().length, 0);
  consumed();
});
