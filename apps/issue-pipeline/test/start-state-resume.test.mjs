// @ts-check
// startState after a stop (`every-role-resumes`): the restart resumes at the
// stage that stopped, never running a finished one again, with the saved
// state carried and the limits reset. A stage after review stands only on a
// review of the branch's head; a specced issue goes straight to implement,
// and one with no spec is specified first.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setEnv } from "./ops-run-test-kit.mjs";

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { startState } = await import("../src/start-state.ts");

const PR = 50;
const HEAD = "h1";
const FINDINGS = [{ id: "f1", status: "resolved" }];
// The issue stopped at `stage`, its branch at HEAD, reviewed there.
/** @param {string} stage @param {object} [fields] @returns {import("../src/state.ts").State} */
function stoppedAt(stage, fields = {}) {
  return {
    version: 1,
    number: 7,
    depth: 0,
    pr: PR,
    headSha: HEAD,
    reviewedSha: HEAD,
    verifiedSha: HEAD,
    stage: "stopped",
    stoppedStage: stage,
    stopCode: "budget",
    stopReason: "the issue's token budget ran out",
    plan: "P",
    spec: "S",
    files: ["src/a.ts"],
    triages: 2,
    continuations: { implement: 1 },
    round: 3,
    ciFixes: 2,
    syncs: 4,
    conflictFixes: 1,
    findings: FINDINGS,
    nextFindingId: 2,
    log: ["a"],
    ...fields,
  };
}
const ctx = {
  n: 7,
  depth: 0,
  remote: HEAD,
  pr: PR,
  hasWork: true,
  keptUnpushed: false,
  answered: false,
  now: new Date("2026-10-16T20:00:00Z"),
};
const LIMITS = {
  triages: 0,
  continuations: {},
  round: 0,
  ciFixes: 0,
  syncs: 0,
  conflictFixes: 0,
};

for (const stage of [
  "triage",
  "spec",
  "implement",
  "open-pr",
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]) {
  test(`a stop at ${stage} resumes at ${stage}, its state carried and limits reset`, () => {
    const resumed = startState(stoppedAt(stage), ctx);
    const { triages, continuations, round, ciFixes, syncs, conflictFixes } =
      resumed;
    const { plan, spec, files, findings, reviewedSha, verifiedSha } = resumed;
    const { stopCode, stopReason, stoppedStage, log } = resumed;
    assert.deepEqual(
      {
        stage: resumed.stage,
        plan,
        spec,
        files,
        findings,
        reviewedSha,
        verifiedSha,
        limits: {
          triages,
          continuations,
          round,
          ciFixes,
          syncs,
          conflictFixes,
        },
        stop: [stopCode, stopReason, stoppedStage],
        last: log?.at(-1),
      },
      {
        stage,
        plan: "P",
        spec: "S",
        files: ["src/a.ts"],
        findings: FINDINGS,
        reviewedSha: HEAD,
        verifiedSha: HEAD,
        limits: LIMITS,
        stop: [null, null, null],
        last: `2026-10-16T20:00Z restarted at ${stage} after the budget stop; limits reset`,
      },
    );
  });
}

test("a stop at fix with a finding open resumes at fix", () => {
  const open = [{ id: "f1", status: "open" }];
  const { stage, findings } = startState(stoppedAt("fix", { findings: open }), {
    ...ctx,
    remote: "h2",
  });
  assert.deepEqual([stage, findings], ["fix", open]);
});

test("a review of the branch's head stands, so a stop at review or fix goes on to sync", () => {
  for (const stage of ["review", "fix"]) {
    const { stage: resumed, reviewedSha } = startState(stoppedAt(stage), ctx);
    assert.deepEqual([resumed, reviewedSha], ["sync", HEAD]);
  }
});

test("a stage after review whose head moved since the review goes back to review", () => {
  const resumed = startState(stoppedAt("checks"), { ...ctx, remote: "h2" });
  assert.deepEqual(
    [resumed.stage, resumed.findings, resumed.reviewedSha, resumed.headSha],
    ["review", [], null, "h2"],
  );
  assert.equal("nextFindingId" in resumed, false);
});

test("unpushed commits kept in the worktree leave no review standing", () => {
  const { stage } = startState(stoppedAt("merge"), {
    ...ctx,
    keptUnpushed: true,
  });
  assert.equal(stage, "review");
});

test("a restart with a saved spec skips triage and spec and resumes implement", () => {
  const { stage, spec } = startState(
    stoppedAt("implement", { stopCode: "too-large" }),
    { ...ctx, hasWork: false },
  );
  assert.deepEqual([stage, spec], ["implement", "S"]);
});

test("a restart at implement without a spec still specifies the issue", () => {
  const { stage } = startState(stoppedAt("implement", { spec: null }), ctx);
  assert.equal(stage, "spec");
});

test("a lost state with no spec still starts at triage", () => {
  const { stage } = startState(null, { ...ctx, hasWork: false });
  assert.equal(stage, "triage");
});

test("answered questions still go back to triage, whatever stopped", () => {
  const { stage } = startState(stoppedAt("implement"), {
    ...ctx,
    answered: true,
    hasWork: false,
  });
  assert.equal(stage, "triage");
});

test("a too-large stop at spec resumes spec with its continuations cleared and its start heads and attempts kept", () => {
  const kept = { startSha: "s0", startWikiSha: null, attempts: 1 };
  const state = stoppedAt("spec", {
    stopCode: "too-large",
    spec: null,
    checkpoints: { ...kept, continuations: 1 },
  });
  const got = startState(state, ctx);
  assert.equal(got.stage, "spec");
  assert.deepEqual(got.checkpoints, kept);
});
