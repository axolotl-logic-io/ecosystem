// @ts-check
// Recovery uses a private fake GitHub, saved authoritative comments and real
// merge objects. Child interruption is at an explicit protocol boundary.
import { spawnSync } from "node:child_process";
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
} from "../explicit-target-test-kit.mjs";
import { BRANCH, ISSUE, PR, REPO } from "../explicit-target-world-test-kit.mjs";

const { readWriteState } = await import("../../src/saved-state.ts");
const { signed } = await import("../../src/comments.ts");
const { mergedText } = await import("../../src/ops/merge-comment.ts");
/** @typedef {import("../explicit-target-world-test-kit.mjs").World} World */
/** @param {World} w */
function confirmation(w) {
  return [
    prStep(w, mergedView(w)),
    prStep(w, mergedView(w), true),
    ...resultInputs(w),
  ];
}
/** @returns {string[][]} */
function posts() {
  return calls().filter((args) => args[1] === `repos/${REPO}/merges`);
}
/** @param {World} w @param {object} payload */
function child(w, payload) {
  return spawnSync(
    process.execPath,
    [
      new URL("./explicit-target-recovery-child-test-kit.mjs", import.meta.url)
        .pathname,
    ],
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
/** @param {World} w */
function interruptAfterResponse(w) {
  script(w, [...prechecks(w), post(w), { ...prStep(w), interrupt: true }]);
  const interrupted = child(w, { ...request(w), op: "merge" });
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

export { child, confirmation, interruptAfterResponse, mergeComment, posts };
