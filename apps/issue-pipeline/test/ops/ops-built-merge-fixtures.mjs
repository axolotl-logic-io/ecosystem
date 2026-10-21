// @ts-check
// Real multi-commit feature and ordered result for source/bundle parity.
import fs from "node:fs";
import path from "node:path";
import { sh } from "./ops-test-kit.mjs";

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

export { mergeWorld };
