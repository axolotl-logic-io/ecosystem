// @ts-check
// Recovery uses a private fake GitHub, saved authoritative comments and real
// merge objects. Child interruption is at an explicit protocol boundary.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  calls,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  resultInputs,
  script,
} from "./explicit-target-test-kit.mjs";
import {
  BRANCH,
  git,
  ISSUE,
  PR,
  REPO,
} from "./explicit-target-world-test-kit.mjs";

const { stateBody, readWriteState } = await import("../src/saved-state.ts");
const { signed } = await import("../src/comments.ts");
const { mergedText } = await import("../src/ops/merge-comment.ts");
/** @typedef {import("./explicit-target-world-test-kit.mjs").World} World */
/** @param {World} w */
function confirmation(w) {
  const steps = [prStep(w, mergedView(w))];
  if (w.merged !== w.head) {
    steps.push(prStep(w, mergedView(w), true));
  }
  return [...steps, ...resultInputs(w)];
}
/** @returns {string[][]} */
function posts() {
  return calls().filter((args) => args[0] === "git" && args.includes("push"));
}
/** @param {World} w @param {object} payload */
function child(w, payload) {
  return spawnSync(
    process.execPath,
    [new URL("./explicit-target-recovery-child.mjs", import.meta.url).pathname],
    {
      input: JSON.stringify({
        op: "reconcile-merge",
        ...payload,
        payload,
        slug: w.cfg.slug,
        config: path.join(w.place, "config.json"),
        checkout: { issue: ISSUE, dir: w.wt, branch: BRANCH },
      }),
      cwd: w.wt,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
/** @param {World} w @param {string | null} [result] */
function retainLegacyAttempt(w, result = w.merged) {
  const state = {
    ...w.state,
    mergeAttempt: {
      repo: w.cfg.repo,
      pr: PR,
      target: w.cfg.baseBranch,
      branch: BRANCH,
      authorized: w.revision,
      hardened: w.state.hardened ?? w.revision,
      integration: w.state.integration,
      result,
      reads: 0,
    },
  };
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  git(w.origin, ["update-ref", `refs/heads/${w.cfg.baseBranch}`, w.merged]);
}

/** @param {World} w */
function interruptAfterResponse(w) {
  let interrupted;
  if (w.merged === w.head) {
    script(w, [...prechecks(w), post(w), { ...prStep(w), interrupt: true }]);
    interrupted = child(w, { ...request(w), op: "merge" });
  } else {
    retainLegacyAttempt(w);
    script(w, [{ ...prStep(w), interrupt: true }]);
    interrupted = child(w, { op: "reconcile-merge", number: ISSUE });
  }
  return { interrupted, saved: readWriteState(w.cfg, ISSUE) };
}

/** @param {World} w */
function mergeComment(w) {
  return {
    args: [
      "api",
      "-X",
      "POST",
      `repos/${REPO}/issues/${PR}/comments`,
      "-f",
      `body=${signed({ role: "merger" }, `${mergedText(w.state, w.head, w.merged)}\n\n`)}`,
      "--silent",
    ],
  };
}

export {
  child,
  confirmation,
  interruptAfterResponse,
  mergeComment,
  posts,
  retainLegacyAttempt,
};
