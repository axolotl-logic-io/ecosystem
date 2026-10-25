// Real multi-commit feature and ordered result for source/bundle parity.
import fs from "node:fs";
import path from "node:path";
import type { Revision } from "../../src/state.ts";
import { releaseReplies } from "./ops-release-test-kit.ts";
import type { World } from "./ops-test-kit.ts";
import { ask, calls, fakeGh, ISSUE, LANE, SWEEP, sh } from "./ops-test-kit.ts";

const PR = 50;
const GIT_USER = "-c user.email=a@b -c user.name=a";

function mergeWorld(w: World): World & { mergeSha: string } {
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

function candidateState(
  state: Record<string, unknown>,
  revision: Revision,
): Record<string, unknown> {
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

function releaseAndCalls(
  w: World,
  state: Record<string, unknown>,
  ops: string | undefined,
  constant: (text: string) => string,
): { released: string; releaseCalls: string[] } {
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
