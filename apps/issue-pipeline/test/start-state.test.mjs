// startState and branchHasWork: where a stopped, answered or restarted issue
// starts again ("start from branch").
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
process.env.ISSUE_PIPELINE_ROOT = d;
const { startState } = await import("../src/state.ts");
const { branchHasWork } = await import("../src/checkouts.ts");
const t = (name, got, want) => test(name, () => assert.deepEqual(got, want));
const now = new Date("2026-10-15T03:00:00Z");
const base = { version: 1, number: 7, depth: 1, pr: 50, headSha: "h1", reviewedSha: "h0", verifiedSha: "h1", plan: "P", spec: "S", allocated: 990000, round: 2, ciFixes: 2, syncs: 9, triages: 2, findings: [{ status: "resolved" }], resolvedHistory: ["r"], log: ["a"] };
const ctx = { n: 7, depth: 1, remote: "h1", pr: 50, hasWork: true, answered: false, now };
// budget stop at security, branch has work -> review, limits reset, plan/spec kept
let s = startState({ ...base, stage: "stopped", stopCode: "budget" }, ctx);
t("budget stop -> review", [s.stage, s.allocated, s.round, s.ciFixes, s.syncs, s.triages, s.plan, s.spec, s.pr, s.implemented, s.verifiedSha, s.headSha], ["review", 0, 0, 0, 0, 0, "P", "S", 50, true, null, "h1"]);
t("log entry", s.log.at(-1), "2026-10-15T03:00Z restarted on the existing branch (PR #50) at review after the budget stop; limits reset");
t("stopCode dropped", "stopCode" in s, false);
// review stands -> sync
s = startState({ ...base, stage: "stopped", stopCode: "acceptance", reviewedSha: "h1" }, ctx);
t("review stands -> sync", [s.stage, s.reviewedSha, s.allocated], ["sync", "h1", 0]);
s = startState({ ...base, stage: "stopped", stopCode: "acceptance", reviewedSha: "h1", findings: [{ status: "open" }] }, ctx);
t("open finding -> review", s.stage, "review");
// answered questions with work -> review, plan/spec dropped
s = startState({ ...base, stage: "triage", questionsAt: "x", reviewedSha: "h1" }, { ...ctx, answered: true });
t("answered with work -> review, no plan/spec", [s.stage, s.plan, "spec" in s, s.triages, s.log.at(-1).includes("answered questions")], ["review", null, false, 0, true]);
// answered, no work -> triage, counters kept
s = startState({ ...base, stage: "triage", triages: 2, pr: 50 }, { ...ctx, answered: true, hasWork: false });
t("answered no work -> triage keeps triages", [s.stage, s.triages, s.allocated], ["triage", 2, 990000]);
// stopped, no work (empty start-pr branch) -> triage fresh
s = startState({ ...base, stage: "stopped", stopCode: "error", implemented: false }, { ...ctx, hasWork: false });
t("stopped no work -> triage fresh", [s.stage, s.allocated, s.pr, s.implemented], ["triage", 0, 50, false]);
// stopped, PR closed (pr null), branch exists -> triage, state.pr kept
s = startState({ ...base, stage: "stopped", stopCode: "error" }, { ...ctx, pr: null, hasWork: false });
t("no open PR -> triage", [s.stage, s.pr], ["triage", 50]);
// lost state, PR + work exist -> review
s = startState(null, ctx);
t("no state, work -> review", [s.stage, s.pr, s.depth, s.plan, s.log.at(-1).includes("a lost state")], ["review", 50, 1, null, true]);
// new issue, nothing exists -> triage
s = startState(null, { ...ctx, remote: null, pr: null, hasWork: false });
t("new issue -> triage", [s.stage, s.pr, s.headSha, s.depth], ["triage", null, null, 1]);
// lapsed lease mid-stage is not a start
const mid = { ...base, stage: "verify" };
t("mid-stage unchanged", startState(mid, ctx) === mid, true);

// branchHasWork against real repos
const sh = (c) => { const r = spawnSync("bash", ["-c", c], { encoding: "utf8" }); if (r.status) throw new Error(c + "\n" + r.stderr); return r.stdout.trim(); };
sh(`cd ${d} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git config user.email a@b && git config user.name a && echo 1 > f && git add f && git commit -qm base && git push -q origin HEAD:integration`);
sh(`cd ${d}/seed && git checkout -qb agent/issue-7 && git commit -q --allow-empty -m start && git push -q origin agent/issue-7`);
const emptySha = sh(`cd ${d}/seed && git rev-parse HEAD`);
sh(`cd ${d}/seed && git checkout -qb agent/issue-8 integration && echo 2 > g && git add g && git commit -qm work && git push -q origin agent/issue-8`);
const workSha = sh(`cd ${d}/seed && git rev-parse HEAD`);
// rebased (non-ff) branch: rewrite issue-8 after clone has fetched it once
sh(`mkdir -p ${d}/clones && git clone -q ${d}/origin.git ${d}/clones/o__r`);
const cfg = { baseBranch: "integration", slug: "o__r" };
t("empty start commit -> no work", branchHasWork(cfg, 7, emptySha), false);
t("real change -> work", branchHasWork(cfg, 8, workSha), true);
sh(`cd ${d}/seed && git checkout -q agent/issue-8 && git commit -q --amend -m reworked && git push -qf origin agent/issue-8`);
const amended = sh(`cd ${d}/seed && git rev-parse HEAD`);
t("non-ff rewritten branch -> work", branchHasWork(cfg, 8, amended), true);
// base gained the same change: three-dot diff is from the merge base, still work
sh(`cd ${d}/seed && git checkout -q integration && echo 3 > h && git add h && git commit -qm more && git push -q origin integration`);
t("base moved ahead -> start-only branch still no work", branchHasWork(cfg, 7, emptySha), false);
