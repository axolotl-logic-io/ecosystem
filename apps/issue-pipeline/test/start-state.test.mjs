// @ts-check
// startState and branchHasWork: where a stopped, answered or restarted issue
// starts again ("start from branch").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
/** @import { State } from "../src/state.ts" */

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { startState } = await import("../src/start-state.ts");
const { branchHasWork } = await import("../src/git-state.ts");
const now = new Date("2026-10-15T03:00:00Z");
const PR = 50;
const ALLOCATED = 990_000;
const base = {
  version: 1,
  number: 7,
  depth: 1,
  pr: PR,
  headSha: "h1",
  reviewedSha: "h0",
  verifiedSha: "h1",
  plan: "P",
  spec: "S",
  allocated: ALLOCATED,
  round: 2,
  ciFixes: 2,
  syncs: 9,
  triages: 2,
  findings: [{ status: "resolved" }],
  resolvedHistory: ["r"],
  log: ["a"],
};
const ctx = {
  n: 7,
  depth: 1,
  remote: "h1",
  pr: PR,
  hasWork: true,
  keptUnpushed: false,
  answered: false,
  now,
};

const RESTART_AT_REVIEW = /restarted .*at review/u;

// The last line of a state's log.
/** @param {State} state @returns {string} */
function lastLogLine({ log }) {
  return z.string().parse(log?.at(-1));
}

// budget stop at security, branch has work -> review, limits reset, plan/spec kept
/** @returns {State} */
function budgetRestart() {
  return startState({ ...base, stage: "stopped", stopCode: "budget" }, ctx);
}

test("budget stop -> review", () => {
  const {
    stage,
    allocated,
    round,
    ciFixes,
    syncs,
    triages,
    plan,
    spec,
    pr,
    implemented,
    verifiedSha,
    headSha,
  } = budgetRestart();
  assert.deepEqual(
    [
      stage,
      allocated,
      round,
      ciFixes,
      syncs,
      triages,
      plan,
      spec,
      pr,
      implemented,
      verifiedSha,
      headSha,
    ],
    ["review", 0, 0, 0, 0, 0, "P", "S", PR, true, null, "h1"],
  );
});
// The log records the restart, the stage it restarts at and the stop.
test("log entry", () => {
  const line = lastLogLine(budgetRestart());
  assert.match(line, RESTART_AT_REVIEW);
  assert.ok(line.includes("budget"));
});
test("stopCode dropped", () => {
  assert.deepEqual("stopCode" in budgetRestart(), false);
});
// review stands -> sync
test("review stands -> sync", () => {
  const { stage, reviewedSha, allocated } = startState(
    { ...base, stage: "stopped", stopCode: "acceptance", reviewedSha: "h1" },
    ctx,
  );
  assert.deepEqual([stage, reviewedSha, allocated], ["sync", "h1", 0]);
});
test("open finding -> review", () => {
  const s = startState(
    {
      ...base,
      stage: "stopped",
      stopCode: "acceptance",
      reviewedSha: "h1",
      findings: [{ status: "open" }],
    },
    ctx,
  );
  assert.deepEqual(s.stage, "review");
});
// answered questions with work -> review, plan/spec dropped
test("answered with work -> review, no plan/spec", () => {
  const s = startState(
    { ...base, stage: "triage", questionsAt: "x", reviewedSha: "h1" },
    { ...ctx, answered: true },
  );
  const { stage, plan, triages } = s;
  assert.deepEqual(
    [
      stage,
      plan,
      "spec" in s,
      triages,
      lastLogLine(s).includes("answered questions"),
    ],
    ["review", null, false, 0, true],
  );
});
// answered, no work -> triage, counters kept
test("answered no work -> triage keeps triages", () => {
  const { stage, triages, allocated } = startState(
    { ...base, stage: "triage", triages: 2, pr: PR },
    { ...ctx, answered: true, hasWork: false },
  );
  assert.deepEqual([stage, triages, allocated], ["triage", 2, ALLOCATED]);
});
// stopped, no work (empty start-pr branch) -> triage fresh
test("stopped no work -> triage fresh", () => {
  const { stage, allocated, pr, implemented } = startState(
    { ...base, stage: "stopped", stopCode: "error", implemented: false },
    { ...ctx, hasWork: false },
  );
  assert.deepEqual(
    [stage, allocated, pr, implemented],
    ["triage", 0, PR, false],
  );
});
// stopped, PR closed (pr null), branch exists -> triage, state.pr kept
test("no open PR -> triage", () => {
  const { stage, pr } = startState(
    { ...base, stage: "stopped", stopCode: "error" },
    { ...ctx, pr: null, hasWork: false },
  );
  assert.deepEqual([stage, pr], ["triage", PR]);
});
// wiki-only work, no PR (with or without a code branch) -> review, pr null
for (const remote of ["h1", null]) {
  test(`wiki-only work, no PR -> review (remote ${remote})`, () => {
    const s = startState(
      { ...base, stage: "stopped", stopCode: "budget" },
      { ...ctx, pr: null, hasWork: true, remote },
    );
    const { stage, pr, implemented } = s;
    assert.deepEqual(
      [stage, pr, implemented, lastLogLine(s)],
      [
        "review",
        null,
        true,
        "2026-10-15T03:00Z restarted on the existing branch (no PR) at review after the budget stop; limits reset",
      ],
    );
  });
}
// never reviewed, wiki-only work with no code branch: no review stands -> review
test("never reviewed, no code branch -> review", () => {
  const { stage, reviewedSha } = startState(
    { ...base, stage: "stopped", stopCode: "budget", reviewedSha: null },
    { ...ctx, pr: null, hasWork: true, remote: null },
  );
  assert.deepEqual([stage, reviewedSha], ["review", null]);
});
// lost state, PR + work exist -> review
test("no state, work -> review", () => {
  const s = startState(null, ctx);
  const { stage, pr, depth, plan } = s;
  assert.deepEqual(
    [stage, pr, depth, plan, lastLogLine(s).includes("a lost state")],
    ["review", PR, 1, null, true],
  );
});
// new issue, nothing exists -> triage
test("new issue -> triage", () => {
  const { stage, pr, headSha, depth } = startState(null, {
    ...ctx,
    remote: null,
    pr: null,
    hasWork: false,
  });
  assert.deepEqual([stage, pr, headSha, depth], ["triage", null, null, 1]);
});
// lapsed lease mid-stage is not a start
test("mid-stage unchanged", () => {
  const mid = { ...base, stage: "verify" };
  assert.deepEqual(startState(mid, ctx), mid);
});

// branchHasWork against real repos
/** @param {string} c @returns {string} */
function sh(c) {
  const r = spawnSync("bash", ["-c", c], { encoding: "utf8" });
  if (r.status) {
    throw new Error(`${c}\n${r.stderr}`);
  }
  return r.stdout.trim();
}
// Issue 7's branch holds only the empty start commit; issue 8's holds work.
const EMPTY_ISSUE = 7;
const WORK_ISSUE = 8;
sh(
  `cd ${d} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git config user.email a@b && git config user.name a && echo 1 > f && git add f && git commit -qm base && git push -q origin HEAD:integration`,
);
sh(
  `cd ${d}/seed && git checkout -qb agent/issue-7 && git commit -q --allow-empty -m start && git push -q origin agent/issue-7`,
);
const emptySha = sh(`cd ${d}/seed && git rev-parse HEAD`);
sh(
  `cd ${d}/seed && git checkout -qb agent/issue-8 integration && echo 2 > g && git add g && git commit -qm work && git push -q origin agent/issue-8`,
);
const workSha = sh(`cd ${d}/seed && git rev-parse HEAD`);
// rebased (non-ff) branch: rewrite issue-8 after clone has fetched it once
sh(`mkdir -p ${d}/clones && git clone -q ${d}/origin.git ${d}/clones/o__r`);
/** @type {Config} */
const cfg = {
  account: "bot",
  allowedUsers: ["alice"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  contextLimits: { soft: 150_000, hard: 175_000 },
  leaseHours: 3,
  maxContinuations: 1,
  practices: [],
  repo: "o/r",
  slug: "o__r",
};
const emptyHasWork = branchHasWork(cfg, EMPTY_ISSUE, emptySha);
const workHasWork = branchHasWork(cfg, WORK_ISSUE, workSha);
sh(
  `cd ${d}/seed && git checkout -q agent/issue-8 && git commit -q --amend -m reworked && git push -qf origin agent/issue-8`,
);
const amended = sh(`cd ${d}/seed && git rev-parse HEAD`);
const amendedHasWork = branchHasWork(cfg, WORK_ISSUE, amended);
// base gained the same change: three-dot diff is from the merge base, still work
sh(
  `cd ${d}/seed && git checkout -q integration && echo 3 > h && git add h && git commit -qm more && git push -q origin integration`,
);
const movedBaseHasWork = branchHasWork(cfg, EMPTY_ISSUE, emptySha);
test("empty start commit -> no work", () => {
  assert.deepEqual(emptyHasWork, false);
});
test("real change -> work", () => {
  assert.deepEqual(workHasWork, true);
});
test("non-ff rewritten branch -> work", () => {
  assert.deepEqual(amendedHasWork, true);
});
test("base moved ahead -> start-only branch still no work", () => {
  assert.deepEqual(movedBaseHasWork, false);
});
