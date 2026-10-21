// @ts-check
// Real multi-commit feature and ordered result for source/bundle parity.
import fs from "node:fs";
import path from "node:path";
import { releaseReplies } from "./ops-release-test-kit.mjs";
import { ask, calls, fakeGh, ISSUE, LANE, SWEEP, sh } from "./ops-test-kit.mjs";

const PR = 50;
const GIT_USER = "-c user.email=a@b -c user.name=a";

/** @param {import("./ops-test-kit.mjs").World} w @returns {import("./ops-test-kit.mjs").World & { mergeSha: string }} */
function mergeWorld(w) {
  for (const name of ["first", "second"]) {
    fs.writeFileSync(path.join(w.worktree, `${name}.txt`), `${name}\n`);
    sh(
      `git -C ${w.worktree} add ${name}.txt && git -C ${w.worktree} ${GIT_USER} commit -qm ${name}`,
    );
  }
  const sha = sh(`git -C ${w.worktree} rev-parse HEAD`);
  const tree = sh(`git -C ${w.worktree} rev-parse HEAD^{tree}`);
  const mergeSha = sh(
    `git -C ${w.worktree} ${GIT_USER} commit-tree ${tree} -p origin/integration -p ${sha} -m merged`,
  );
  sh(`git -C ${w.worktree} update-ref refs/fixture/result ${mergeSha}`);
  sh(
    `git -C ${w.worktree} push -q origin HEAD:refs/heads/agent/issue-7 refs/fixture/result`,
  );
  return { ...w, sha, mergeSha };
}

/**
 * @param {Record<string, unknown>} state
 * @param {import("../../src/state.ts").Revision} revision
 * @returns {Record<string, unknown>}
 */
function candidateState(state, revision) {
  const { hardenedTarget } = state;
  return {
    ...state,
    hardened: revision,
    verifiedSha: revision.code,
    security: {
      revision,
      commentId: 901,
      finding: null,
      phase: "candidate",
      target: hardenedTarget,
    },
  };
}

/**
 * @param {import("./ops-test-kit.mjs").World} w
 * @param {Record<string, unknown>} state
 * @param {string | undefined} ops
 * @param {(text: string) => string} constant
 */
function releaseAndCalls(w, state, ops, constant) {
  fakeGh.reply(
    releaseReplies({ ...state, codeMerged: { pr: PR, sha: w.sha } }),
  );
  const release_ = { op: "release", number: ISSUE, lane: LANE, sweepId: SWEEP };
  const released = ask(
    w,
    { ...release_, state: { ...state, lease: null } },
    ops,
  );
  const releaseCalls = calls().map((args) => constant(args.join(" ")));
  return { released, releaseCalls };
}

export { candidateState, mergeWorld, releaseAndCalls };
