// @ts-check
// A lost native push acknowledgement, then a current-policy result observation.
import fs from "node:fs";
import path from "node:path";
import {
  consumed,
  post,
  prechecks,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import {
  ISSUE,
  ISSUE_DATA,
  PR,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import {
  confirmation,
  mergeComment,
} from "./explicit-target-recovery-test-kit.mjs";

const { loadConfig } = await import("../../src/config.ts");
const { merge } = await import("../../src/ops/merge.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const { saveState } = await import("../../src/ops/save-state.ts");
const { policyRevision } = await import("../../src/project-policy.ts");
const { resultReviewTarget } = await import("../../src/security-clearance.ts");
const { recorded } = await import("../../src/roles/merge/security-record.ts");
const RESULT_TIMEOUT_MINUTES = 123;
/** @typedef {import("../explicit-target-world-test-kit.mjs").World} World */
/** @typedef {import("../../src/state.ts").IssueState} IssueState */

/** @param {World} w @param {IssueState} state @returns {import("../../src/job/role-context.ts").RoleContext} */
function resultContext(w, state) {
  return {
    cfg: w.cfg,
    issue: ISSUE,
    stage: "merge",
    state,
    dirs: { job: w.place, repo: w.wt },
    issueFile: path.join(w.place, "issue.md"),
    inputs: {
      issue: ISSUE_DATA,
      comments: [],
      revision: w.revision.inputs,
      gherkin: null,
    },
    mergeQueue: null,
    op() {
      return Promise.reject(new Error("unexpected result observation op"));
    },
    session() {
      return Promise.reject(new Error("unexpected result observation session"));
    },
    post() {
      return Promise.resolve(PR);
    },
    save(saved) {
      saveState(w.cfg, { number: ISSUE, state: saved });
      return Promise.resolve();
    },
  };
}

/** @param {import("../../src/state.ts").Security["finding"]} finding */
async function confirmedLostResponse(finding) {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w, { code: 1, stderr: "acknowledgement lost after receive-pack" }),
    ...confirmation(w),
    mergeComment(w),
  ]);
  const reply = merge(w.cfg, request(w), confirmationClock());
  const confirmed = readWriteState(w.cfg, ISSUE);
  const file = path.join(w.place, "config.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...original,
      commandTimeoutMinutes: RESULT_TIMEOUT_MINUTES,
    }),
  );
  w.cfg = { ...loadConfig(file), slug: w.cfg.slug };
  const revision = { ...w.revision, ...policyRevision(w.cfg) };
  const target = resultReviewTarget(confirmed, revision);
  if (target === null) {
    throw new Error("missing own-merge result review target");
  }
  const resultSecurity = { revision, target, commentId: PR, finding };
  const review = await recorded(resultContext(w, confirmed), confirmed, {
    revision,
    resultTarget: target,
    reply: { summary: "Current-policy result review", security: finding },
  });
  const reviewed = readWriteState(w.cfg, ISSUE);
  consumed();
  return { w, confirmed, resultSecurity, reviewed, review, reply };
}

export { confirmedLostResponse };
