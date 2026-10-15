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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assertClean,
  branchHasWork,
  ensureClone,
  ensureWorktree,
  fetchIn,
  head,
  push,
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
import { commentOnlyChange } from "./comment-only.ts";
import {
  AFTER_MARK,
  comment,
  listComments,
  PARENT_MARK,
  pipelineRole,
  signed,
} from "./comments.ts";
import { loadConfig, paths, publicConfig, wikiCfg } from "./config.ts";
import { gh, ghJson, git, isAllowedUser } from "./github.ts";
import { matchAny } from "./globs.ts";
import { writeIssueContext } from "./issue-context.ts";
import {
  clearStopLabels,
  ensureLabels,
  isPipelineLabel,
  LABELS,
  setLabels,
} from "./labels.ts";
import { RESERVATION_MS, withCloneLock, withRepoLock } from "./locks.ts";
import { ROOT } from "./pipeline-root.ts";
import { OpsError, run, shell, tail } from "./process.ts";
import { readState, startState, writeState } from "./state.ts";
import { isStopLabel, STOPS, stopFor } from "./stops.ts";
import { ensureWiki, pushWiki, wikiDiff } from "./wiki.ts";
import { ask } from "./ops/ask.ts";
import { claim } from "./ops/claim.ts";
import { openPrFor } from "./ops/prs.ts";
import { saveState } from "./ops/save-state.ts";
import { split } from "./ops/split.ts";
import { stop } from "./ops/stop.ts";
import { sweep } from "./ops/sweep.ts";

// ---------- operations ----------

const ops = {};

ops.sweep = sweep;

ops.claim = claim;

// Writes state and nothing else; queued comments ride along on every op (see main).
ops["save-state"] = saveState;

ops.ask = ask;

ops.split = split;

// Stop an issue at a failed control: label it agent:stopped-<code>, and explain
// on the issue and its PR which control stopped it, why, and how to resume.
ops.stop = stop;

// PRs link to their issue twice: the body starts with "Closes #N", which links the
// PR under the issue's Development section and closes it on merge, and the title
// ends with "(#N)", so the squash commit on the base branch names the issue too.
const titleFor = (n, title) => (new RegExp(`#${n}\\b`).test(title) ? title : `${title} (#${n})`);
const closesBody = (n, text) =>
  new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${n}\\b`, "i").test(text) ? text : `Closes #${n}\n\n${text}`;

// Open the issue's PR as a draft as soon as triage says ready, before any code is
// written. GitHub refuses a PR with no commits, so the branch starts with an empty
// commit; the squash merge drops it. open-pr later fills in the PR and marks it ready.
ops["start-pr"] = (cfg, req) => {
  const n = req.number;
  const issue = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}`]);
  const wt = ensureWorktree(cfg, n);
  let sha = remoteHead(cfg, n);
  if (!sha) {
    assertClean(wt);
    run("git", ["-C", wt, "commit", "--allow-empty", "-m", `Start work on #${n}\n\nPipeline-Agent: coordinator`]);
    sha = push(cfg, n, { allowEmpty: true });
  }
  let pr = openPrFor(cfg, n);
  if (!pr) {
    const text = [
      "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description and marks it ready for review once the change is pushed.",
      req.plan ? `\n<details><summary>Plan</summary>\n\n${req.plan}\n\n</details>` : "",
    ].join("\n");
    const url = gh(cfg, ["pr", "create", "-R", cfg.repo, "--draft", "--base", cfg.baseBranch, "--head", paths.branch(n), "--title", titleFor(n, issue.title), "--body", signed({ role: "coordinator" }, closesBody(n, text))]).stdout.trim();
    pr = Number(url.split("/").pop());
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha: sha };
};

ops["open-pr"] = (cfg, req) => {
  const n = req.number;
  const sha = push(cfg, n);
  const branch = paths.branch(n);
  const title = titleFor(n, req.title || `Fix #${n}`);
  const body = signed(req.by || { role: "implementer" }, closesBody(n, req.body || ""));
  let pr = openPrFor(cfg, n);
  if (pr) {
    // The draft from start-pr: fill it in and mark it ready for review.
    gh(cfg, ["pr", "edit", String(pr), "-R", cfg.repo, "--title", title, "--body", body]);
    gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo], { allowFail: true });
  } else {
    const url = gh(cfg, ["pr", "create", "-R", cfg.repo, "--base", cfg.baseBranch, "--head", branch, "--title", title, "--body", body]).stdout.trim();
    pr = Number(url.split("/").pop());
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha: sha };
};

ops.push = (cfg, req) => ({ headSha: push(cfg, req.number) });

ops["prepare-review"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const sha = head(wt);
  const base = run("git", ["-C", wt, "merge-base", `origin/${cfg.baseBranch}`, "HEAD"]).stdout.trim();
  // A sync rebases the branch, so an earlier reviewed commit may no longer be in its
  // history. Diffing from it would then show everything the base gained since, so
  // review the whole branch instead.
  const sinceInBranch =
    req.sinceSha && run("git", ["-C", wt, "merge-base", "--is-ancestor", req.sinceSha, sha], { allowFail: true }).code === 0;
  const from = sinceInBranch ? req.sinceSha : base;
  const diff = run("git", ["-C", wt, "diff", "--stat", "--patch", `${from}..${sha}`]).stdout;
  const allChanged = run("git", ["-C", wt, "diff", "--name-only", `${base}..${sha}`]).stdout.split("\n").filter(Boolean);
  const dir = path.join(paths.runDir(cfg, n), `review-${req.tag || "r0"}`);
  fs.mkdirSync(dir, { recursive: true });
  const diffPath = path.join(dir, "diff.patch");
  // Wiki commits come after the code diff. They are always the whole wiki change so
  // far, even in a re-review that shows only the code since the last review.
  const w = wikiDiff(cfg, n);
  const full = w.diff ? `${diff}\n\n# Wiki changes (paths under ${wikiCfg(cfg).dir}/; pushed to the wiki when the PR merges)\n\n${w.diff}` : diff;
  fs.writeFileSync(diffPath, full);
  return {
    headSha: sha,
    baseSha: base,
    diffPath,
    diffLines: full.split("\n").length,
    changedFiles: allChanged.concat(w.files),
  };
};

function rebaseInProgress(wt) {
  return ["rebase-merge", "rebase-apply"].some((d) =>
    fs.existsSync(path.resolve(wt, run("git", ["-C", wt, "rev-parse", "--git-path", d]).stdout.trim())),
  );
}

// Puts the worktree back on the pushed branch, dropping a half-done rebase.
function resetToRemote(cfg, n) {
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) run("git", ["-C", wt, "rebase", "--abort"], { allowFail: true });
  const remote = remoteHead(cfg, n);
  if (remote) run("git", ["-C", wt, "reset", "--hard", remote]);
  run("git", ["-C", wt, "clean", "-fd"]);
}

// With keepConflict, a conflicting rebase is left stopped in the worktree for a
// writer to resolve; finish-sync then checks the result and pushes it.
ops["sync-base"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) resetToRemote(cfg, n); // left over from a crashed run
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const upToDate = run("git", ["-C", wt, "merge-base", "--is-ancestor", `origin/${cfg.baseBranch}`, "HEAD"], { allowFail: true }).code === 0;
  if (upToDate) return { changed: false, conflict: false, headSha: head(wt) };
  const r = run("git", ["-C", wt, "rebase", `origin/${cfg.baseBranch}`], { allowFail: true });
  if (r.code !== 0) {
    const conflicts = run("git", ["-C", wt, "diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.trim();
    const kept = !!req.keepConflict && rebaseInProgress(wt);
    if (!kept) run("git", ["-C", wt, "rebase", "--abort"], { allowFail: true });
    return {
      changed: false,
      conflict: true,
      inRebase: kept,
      conflicts: conflicts.split("\n").filter(Boolean),
      baseSha: run("git", ["-C", wt, "rev-parse", `origin/${cfg.baseBranch}`]).stdout.trim(),
    };
  }
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${paths.branch(n)}`]);
  return { changed: true, conflict: false, headSha: head(wt) };
};

// After a writer resolved a kept rebase: check that the rebase finished on the
// current base with no markers left, then push. Anything else (or abort: true)
// resets the worktree to the pushed branch and reports why.
ops["finish-sync"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  const fail = (reason) => {
    resetToRemote(cfg, n);
    return { resolved: false, reason };
  };
  if (req.abort) return fail(req.reason || "aborted");
  if (rebaseInProgress(wt)) return fail("the rebase was not finished");
  const dirty = run("git", ["-C", wt, "status", "--porcelain"]).stdout.trim();
  if (dirty) return fail(`the worktree has uncommitted changes:\n${tail(dirty, 20)}`);
  const base = `origin/${cfg.baseBranch}`;
  if (run("git", ["-C", wt, "merge-base", "--is-ancestor", base, "HEAD"], { allowFail: true }).code !== 0) return fail(`HEAD is not based on ${base}`);
  const ahead = Number(run("git", ["-C", wt, "rev-list", "--count", `${base}..HEAD`]).stdout.trim());
  if (!ahead) return fail("the branch has no commits left after the rebase");
  const markers = run("git", ["-C", wt, "diff", `${base}...HEAD`, "-U0"]).stdout
    .split("\n")
    .filter((l) => /^\+(<{7}|>{7})( |$)/.test(l) || l === "+=======");
  if (markers.length) return fail(`conflict markers remain:\n${markers.slice(0, 10).join("\n")}`);
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${paths.branch(n)}`]);
  return { resolved: true, headSha: head(wt) };
};

ops.verify = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const sha = head(wt);
  const base = run("git", ["-C", wt, "merge-base", `origin/${cfg.baseBranch}`, "HEAD"]).stdout.trim();
  const changed = run("git", ["-C", wt, "diff", "--name-only", `${base}..${sha}`]).stdout.split("\n").filter(Boolean);
  const logDir = path.join(paths.runDir(cfg, n), `verify-${sha.slice(0, 8)}`);
  const timeout = cfg.commandTimeoutMinutes * 60 * 1000;
  const checks = [];
  const record = (id, pass, detail, res) => checks.push({ id, pass, detail, log: res?.log, tail: pass ? undefined : res?.tail });

  if (cfg.commands.setup) {
    const r = shell(cfg.commands.setup, wt, path.join(logDir, "setup.log"), timeout);
    record("setup", r.code === 0, `exit ${r.code}`, r);
    if (r.code !== 0) return { pass: false, headSha: sha, checks };
  }
  for (const id of ["test", "lint", "typecheck"]) {
    if (!cfg.commands[id]) continue;
    const r = shell(cfg.commands[id], wt, path.join(logDir, `${id}.log`), timeout);
    record(id, r.code === 0, `exit ${r.code}`, r);
  }

  // The new tests must fail when the non-test changes are reverted.
  const tests = changed.filter((f) => matchAny(cfg.testPathGlobs, f));
  const nonTest = changed.filter((f) => !tests.includes(f) && !matchAny(cfg.nonCodePathGlobs, f));
  // A change to comments alone has no behaviour for a test to catch.
  const commentOnly = nonTest.filter((f) => commentOnlyChange(wt, f, base, sha));
  const code = nonTest.filter((f) => !commentOnly.includes(f));
  const testsPass = checks.find((c) => c.id === "test")?.pass;
  if (req.testsOnly) {
    // A clean rebase of a head that already passed every check (workflow: testsOnly).
    // The proof that the tests catch the fix belongs to the change, which the rebase didn't touch.
    record("fails-before-fix", true, "shown before the clean rebase; skipped");
  } else if (!testsPass) {
    // A crashing test command would also "fail before the fix", so this check means nothing until tests pass.
    record("fails-before-fix", false, "not run, because the test command fails on the PR");
  } else if (!code.length) {
    record("fails-before-fix", true, commentOnly.length ? `only comments change in ${commentOnly.join(", ")}; skipped` : "no code changes; skipped");
  } else if (!tests.length) {
    record("fails-before-fix", !cfg.requireNewTests, "the change adds or edits no test files");
  } else {
    const tmp = path.join(paths.runDir(cfg, n), `fails-before-${sha.slice(0, 8)}`);
    withCloneLock(cfg, () => {
      run("git", ["-C", wt, "worktree", "remove", "--force", tmp], { allowFail: true });
      run("git", ["-C", wt, "worktree", "add", "--detach", tmp, sha]);
    });
    try {
      for (const f of code) {
        const existed = run("git", ["-C", tmp, "cat-file", "-e", `${base}:${f}`], { allowFail: true }).code === 0;
        if (existed) run("git", ["-C", tmp, "checkout", base, "--", f]);
        else fs.rmSync(path.join(tmp, f), { force: true });
      }
      if (cfg.commands.setup) shell(cfg.commands.setup, tmp, path.join(logDir, "fails-before-setup.log"), timeout);
      const r = shell(cfg.commands.test, tmp, path.join(logDir, "fails-before-test.log"), timeout);
      record("fails-before-fix", r.code !== 0, r.code !== 0 ? "tests fail with the fix reverted" : "tests still pass with the fix reverted; they do not prove the fix", r);
    } finally {
      withCloneLock(cfg, () => run("git", ["-C", wt, "worktree", "remove", "--force", tmp], { allowFail: true }));
    }
  }

  for (const lf of cfg.lockfiles || []) {
    if (!changed.includes(lf.path)) continue;
    const r = shell(lf.regenerate, wt, path.join(logDir, `lockfile-${path.basename(lf.path)}.log`), timeout);
    const same = run("git", ["-C", wt, "diff", "--quiet", "--", lf.path], { allowFail: true }).code === 0;
    run("git", ["-C", wt, "checkout", "--", lf.path], { allowFail: true });
    record(`lockfile:${lf.path}`, r.code === 0 && same, same ? "regenerated lockfile matches" : "regenerated lockfile differs from the committed one", r);
  }

  const mig = cfg.migrations;
  if (mig && changed.some((f) => matchAny(mig.pathGlobs, f))) {
    for (const step of ["setup", "up", "down", "upAgain"]) {
      const command = step === "upAgain" ? mig.up : mig[step];
      if (!command || (step === "upAgain" && !mig.down)) continue;
      const r = shell(command, wt, path.join(logDir, `migration-${step}.log`), timeout);
      record(`migration:${step}`, r.code === 0, `exit ${r.code}`, r);
      if (r.code !== 0) break;
    }
  }

  run("git", ["-C", wt, "checkout", "--", "."], { allowFail: true });
  return { pass: checks.every((c) => c.pass), headSha: sha, changedFiles: changed, checks };
};

ops["ci-status"] = (cfg, req) => {
  const pr = req.pr;
  const started = Date.now();
  const deadline = started + (req.waitMinutes ?? cfg.ciWaitMinutes) * 60 * 1000;
  for (;;) {
    const view = ghJson(cfg, ["pr", "view", String(pr), "-R", cfg.repo, "--json", "headRefOid"]);
    if (req.expectedSha && view.headRefOid !== req.expectedSha) {
      return { status: "head-changed", headSha: view.headRefOid };
    }
    const r = gh(cfg, ["pr", "checks", String(pr), "-R", cfg.repo, "--required", "--json", "name,state,bucket,link"], { allowFail: true });
    let checks = null;
    try {
      checks = JSON.parse(r.stdout);
    } catch {
      checks = null;
    }
    if (!checks || !checks.length) {
      // GitHub may not have registered checks yet right after a push, so allow 3 minutes.
      if (Date.now() - started > 3 * 60 * 1000) {
        return { status: cfg.requireCi ? "no-checks" : "pass", checks: [] };
      }
    } else {
      const pending = checks.filter((c) => c.bucket === "pending");
      const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
      if (!pending.length) {
        if (!failing.length) return { status: "pass", checks: checks.map((c) => c.name) };
        const logPath = path.join(paths.runDir(cfg, req.number), `ci-${Date.now()}.log`);
        const parts = [];
        for (const c of failing) {
          const m = (c.link || "").match(/actions\/runs\/(\d+)/);
          parts.push(`===== ${c.name} (${c.link}) =====`);
          if (m) parts.push(gh(cfg, ["run", "view", m[1], "-R", cfg.repo, "--log-failed"], { allowFail: true }).stdout.slice(-200000));
        }
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, parts.join("\n"));
        return { status: "fail", failing: failing.map((c) => c.name), logPath };
      }
    }
    if (Date.now() > deadline) return { status: "pending" };
    spawnSync("sleep", ["30"]);
  }
};

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
