#!/usr/bin/env node
// Deterministic git and GitHub operations for the issue pipeline.
//
// The workflow script has no shell, so it runs this file through the
// `issue-pipeline-ops` external-cli agent. The request is one JSON object
// between BEGIN_OPS_REQUEST and END_OPS_REQUEST on stdin. The reply is one
// JSON line on stdout. Handled failures exit 0 with {"ok":false,...}; only
// crashes exit non-zero.
//
// No language model runs here. This file is the only code that reads the
// pipeline's token file.
//
// One GitHub account does everything: opens PRs, posts every agent's review,
// and merges. It may also be a human's own account. So the pipeline never
// tells its comments apart by author. Every comment it posts is signed with
// the agent role that wrote it and carries a hidden PIPELINE_MARK; a comment
// counts as the pipeline's only when it has the mark AND the account wrote it.

import fs from "node:fs";
import {
  branchHasWork,
  ensureClone,
  ensureWorktree,
  fetchIn,
  remoteHead,
  removeWorktree,
} from "./checkouts.ts";
import {
  closeClaims,
  laneOf,
  leaseLane,
  raceForClaim,
  touchClaim,
} from "./claims.ts";
import {
  AFTER_MARK,
  comment,
  listComments,
  PARENT_MARK,
  pipelineRole,
  signed,
} from "./comments.ts";
import { loadConfig, paths, publicConfig } from "./config.ts";
import { gh, ghJson, isAllowedUser } from "./github.ts";
import { writeIssueContext } from "./issue-context.ts";
import {
  clearStopLabels,
  ensureLabels,
  isPipelineLabel,
  LABELS,
  setLabels,
} from "./labels.ts";
import { RESERVATION_MS, withRepoLock } from "./locks.ts";
import { ciStatus } from "./ops/ci-status.ts";
import { prOps } from "./ops/pr.ts";
import { syncOps } from "./ops/sync.ts";
import { verify } from "./ops/verify.ts";
import { ROOT } from "./pipeline-root.ts";
import { OpsError, run, tail } from "./process.ts";
import { readState, startState, writeState } from "./state.ts";
import { isStopLabel, STOPS, stopFor } from "./stops.ts";
import { ensureWiki, pushWiki } from "./wiki.ts";
import { ask } from "./ops/ask.ts";
import { claim } from "./ops/claim.ts";
import { saveState } from "./ops/save-state.ts";
import { split } from "./ops/split.ts";
import { stop } from "./ops/stop.ts";
import { sweep } from "./ops/sweep.ts";

// ---------- operations ----------

const ops = {};
Object.assign(ops, prOps, syncOps);

ops.sweep = sweep;

ops.claim = claim;

// Writes state and nothing else; queued comments ride along on every op (see main).
ops["save-state"] = saveState;

ops.ask = ask;

ops.split = split;

// Stop an issue at a failed control: label it agent:stopped-<code>, and explain
// on the issue and its PR which control stopped it, why, and how to resume.
ops.stop = stop;

ops.verify = verify;

ops["ci-status"] = ciStatus;

// Stages after review, where an issue only waits to merge.
const READY_STAGES = new Set(["sync", "checks", "accept", "security", "merge"]);

// The open issue, other than #n, that should merge before PR `pr`: one past
// review whose PR is older. Without this, a slow issue's long verify keeps
// losing the merge to quick issues in the other slots. An issue whose lease
// expired (a crashed sweep) doesn't hold the line.
function olderReadyIssue(cfg, n, pr) {
  const working = ghJson(cfg, ["issue", "list", "-R", cfg.repo, "--state", "open", "--label", LABELS.working.name, "--limit", "100", "--json", "number,labels"]) || [];
  const leaseMs = cfg.leaseHours * 3600 * 1000;
  let best = null;
  for (const issue of working) {
    if (issue.number === n || issue.labels.some((l) => isStopLabel(l.name))) continue;
    const { state } = readState(cfg, issue.number);
    if (!state || !state.pr || state.pr >= pr || !READY_STAGES.has(state.stage)) continue;
    if (state.lease?.at && Date.now() - Date.parse(state.lease.at) >= leaseMs) continue;
    if (!best || state.pr < best.pr) best = { number: issue.number, pr: state.pr };
  }
  return best;
}

ops.merge = (cfg, req) => {
  const n = req.number;
  const pr = req.state.pr;
  const view = ghJson(cfg, ["pr", "view", String(pr), "-R", cfg.repo, "--json", "headRefOid,state,mergeable,mergeStateStatus,isDraft"]);
  if (view.state === "MERGED") {
    // Someone merged it by hand first. Finish the bookkeeping a merge does.
    finishMerged(cfg, n, pr, req.state);
    return { merged: true, byHand: true };
  }
  if (view.state !== "OPEN") return { merged: false, reason: `PR is ${view.state}` };
  if (view.headRefOid !== req.expectedSha) return { merged: false, reason: "head-changed", headSha: view.headRefOid };
  if (view.mergeable === "CONFLICTING") return { merged: false, reason: "conflict" };
  if (view.mergeStateStatus === "BEHIND") return { merged: false, reason: "behind" };
  // Without branch protection GitHub merges a stale branch without complaint, so
  // check here that the verified commit already contains the current base.
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  if (run("git", ["-C", wt, "merge-base", "--is-ancestor", `origin/${cfg.baseBranch}`, req.expectedSha], { allowFail: true }).code !== 0) {
    return { merged: false, reason: "behind" };
  }
  if (req.mergeOrder) {
    const ahead = olderReadyIssue(cfg, n, pr);
    if (ahead) return { merged: false, reason: "queued", waitingFor: ahead.number, waitingForPr: ahead.pr };
  }
  // The account that opened the PR can't approve it, so there is no review step; the
  // signed comment below records the verdict instead.
  // GitHub won't merge a draft. open-pr marks it ready, but make sure.
  if (view.isDraft) gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo], { allowFail: true });
  const args = ["pr", "merge", String(pr), "-R", cfg.repo, "--squash", "--match-head-commit", req.expectedSha];
  if (cfg.mergeAdmin) args.push("--admin");
  const r = gh(cfg, args, { allowFail: true });
  if (r.code !== 0) {
    const why = tail(r.stderr || r.stdout, 5);
    // Another PR merged first. The next sweep rebases and re-verifies, as for "behind".
    if (/base branch was modified|not up to date with the base|head branch is not up to date/i.test(why)) return { merged: false, reason: "behind" };
    const hint = /approving review|review is required|reviews? required|approv/i.test(why)
      ? " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config."
      : "";
    return { merged: false, reason: `merge refused: ${why}${hint}` };
  }
  comment(cfg, pr, { role: "merger" }, `Merged ${req.expectedSha.slice(0, 12)}: every blocking review finding is resolved and every check passed on this commit.\n\n${req.summary || ""}`);
  finishMerged(cfg, n, pr, req.state);
  return { merged: true };
};

// After a PR merges, by the pipeline or by hand: delete the branch, mark the
// issue done, label both, and remove the worktree (which runs teardown).
function finishMerged(cfg, n, pr, state) {
  gh(cfg, ["api", "-X", "DELETE", `repos/${cfg.repo}/git/refs/heads/${paths.branch(n)}`, "--silent"], { allowFail: true });
  writeState(cfg, n, { ...state, stage: "done", lease: null });
  for (const target of [n, pr]) {
    setLabels(cfg, target, [LABELS.merged.name], [LABELS.working.name]);
    clearStopLabels(cfg, target);
  }
  closeClaims(cfg, n, `PR #${pr} merged.`);
  // GitHub closes an issue from "Closes #N" only when the PR merges into the
  // default branch. A base like integration leaves it open, so close it here.
  const issueState = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}`, "--jq", "{state}"], { allowFail: true });
  if (issueState?.state === "open") {
    gh(cfg, ["issue", "close", String(n), "-R", cfg.repo, "--reason", "completed", "--comment", `PR #${pr} merged into ${cfg.baseBranch}.`], { allowFail: true });
  }
  try {
    const w = pushWiki(cfg, n);
    if (w?.pushed) comment(cfg, n, { role: "merger" }, `Pushed this issue's wiki changes as wiki commit ${w.sha.slice(0, 12)} (history: https://github.com/${cfg.repo}/wiki/_history).`);
  } catch (e) {
    comment(cfg, n, { role: "merger" }, `The wiki changes from this issue were not pushed: ${e.message}`);
    return; // keep the worktree, and its wiki commits, for a person to push
  }
  removeWorktree(cfg, n);
}

ops["close-parent"] = (cfg, req) => {
  const n = req.number;
  const subs = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}/sub_issues?per_page=100`]) || [];
  if (!subs.length) return { closed: false, reason: "no sub-issues found" };
  if (subs.some((s) => s.state !== "closed")) return { closed: false, open: subs.filter((s) => s.state !== "closed").map((s) => s.number) };
  comment(cfg, n, { role: "coordinator" }, `All sub-issues are closed (${subs.map((s) => `#${s.number}`).join(", ")}). Closing.`);
  gh(cfg, ["issue", "close", String(n), "-R", cfg.repo]);
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.split.name]);
  return { closed: true };
};

// Only posts the queued comments (main does that before any op).
ops.post = () => ({});

// The sweep ends with the issue unfinished. Its lane keeps the lease and its claim,
// and its next sweep continues the issue. If the lane never comes back, the lease
// and claim expire after leaseHours and another lane may take the issue.
ops.release = (cfg, req) => {
  const lease = req.state.lease ? { ...req.state.lease, at: new Date().toISOString() } : null;
  writeState(cfg, req.number, { ...req.state, lease });
  touchClaim(cfg, req.number, req);
  return {};
};

// ---------- entry point ----------

// The request runs to the last END marker, not the first: the JSON can carry the
// marker words inside a string, such as a plan or spec about this protocol (#176).
const OPS_REQUEST = /BEGIN_OPS_REQUEST\s*([\s\S]*)END_OPS_REQUEST/u;

function main() {
  const raw = fs.readFileSync(0, "utf8");
  const m = raw.match(OPS_REQUEST);
  let reply;
  try {
    if (!m) throw new OpsError("no BEGIN_OPS_REQUEST ... END_OPS_REQUEST block on stdin");
    const req = JSON.parse(m[1]);
    const handler = ops[req.op];
    if (!handler) throw new OpsError(`unknown op "${req.op}"`);
    const cfg = loadConfig(req.config);
    fs.mkdirSync(ROOT, { recursive: true });
    // Post the signed comments the workflow queued for this issue before running the op,
    // so they land in order and aren't lost if the op fails.
    let posted = 0;
    for (const c of req.comments || []) {
      comment(cfg, c.number, c.by, c.body);
      posted++;
    }
    reply = { ok: true, op: req.op, posted, ...handler(cfg, req) };
  } catch (err) {
    if (!(err instanceof OpsError) && !(err instanceof SyntaxError)) {
      process.stderr.write(String(err?.stack || err));
    }
    reply = { ok: false, error: String(err?.message || err).slice(0, 4000) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

main();
