// @ts-check
// Real gitlinks deliberately point to commits absent from the superproject's
// object store: a successful bundle cannot have read those entries as blobs.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const OLD_COMMIT = "1111111111111111111111111111111111111111";
const NEW_COMMIT = "2222222222222222222222222222222222222222";
const PR = 9;
const BASE = "integration";
const REPLY = z.looseObject({
  ok: z.literal(true),
  headSha: z.string(),
  diffPath: z.string(),
  bundlePath: z.string(),
  bundleText: z.string(),
});

/** @import { OpsFixture } from "../ops-fixtures.mjs" */
/** @typedef {{ reply: z.infer<typeof REPLY>, diff: string, files: string }} Prepared */

/** @param {OpsFixture} fx @param {string} dir @param {string} file @param {string | null} oid @returns {void} */
function setGitlink(fx, dir, file, oid) {
  if (oid === null) {
    fx.sh(`git -C ${dir} update-index --force-remove '${file}'`);
  } else {
    fx.sh(
      `git -C ${dir} update-index --add --cacheinfo 160000,${oid},'${file}'`,
    );
  }
}

// Set a clean starting point on the local origin for each independent range.
/** @param {OpsFixture} fx @param {string | null} oid @param {string} [file] @returns {void} */
function baseGitlink(fx, oid, file = "vendor") {
  const seed = path.join(fx.root, "seed");
  fx.sh(`git -C ${seed} pull -q origin ${BASE}`);
  setGitlink(fx, seed, file, oid);
  fx.sh(`git -C ${seed} commit -q --allow-empty -m baseline`);
  fx.sh(`git -C ${seed} push -q origin HEAD:${BASE}`);
}

// Review starts from an existing checkout; do not initialize submodules,
// whose deliberately unavailable commits must not be needed for bundling.
/** @param {OpsFixture} fx @param {number} n @param {string} file @param {string} text @returns {void} */
function startBranch(fx, n, file, text) {
  const wt = fx.worktree(n);
  fx.sh(`git clone -q -b ${BASE} ${path.join(fx.root, "origin.git")} ${wt}`);
  fx.sh(`git -C ${wt} checkout -qb agent/issue-${n}`);
  fx.commitIn(n, file, text);
}

/** @param {OpsFixture} fx @param {number} n @returns {{ head: string, sha: string }} */
function mergeBranch(fx, n) {
  const head = fx.pushFrom(n);
  const seed = path.join(fx.root, "seed");
  fx.sh(`git -C ${seed} fetch -q origin agent/issue-${n}`);
  fx.sh(`git -C ${seed} merge -q --no-ff -m 'Merge PR' FETCH_HEAD`);
  fx.sh(`git -C ${seed} push -q origin HEAD:${BASE}`);
  return { head, sha: fx.originRef(BASE) };
}

/** @param {OpsFixture} fx @param {number} n @param {{ head: string, sha: string } | null} [merged] @returns {Prepared} */
function prepare(fx, n, merged) {
  /** @type {object} */
  let request = { op: "prepare-review", number: n };
  fx.fakeGh.reply([]);
  if (merged !== null && merged !== undefined) {
    fx.fakeGh.reply([
      {
        when: `pr view ${PR}`,
        stdout: JSON.stringify({
          number: PR,
          state: "MERGED",
          mergeCommit: { oid: merged.sha },
          headRefName: `agent/issue-${n}`,
          headRefOid: merged.head,
          baseRefName: BASE,
          isCrossRepository: false,
        }),
        keep: true,
      },
    ]);
    request = { ...request, codeMerged: { pr: PR, sha: merged.sha } };
  }
  const reply = REPLY.parse(JSON.parse(fx.ask(request)));
  const diff = fs.readFileSync(reply.diffPath, "utf8");
  const written = fs.readFileSync(reply.bundlePath, "utf8");
  if (written !== reply.bundleText || !written.startsWith(diff)) {
    throw new Error(
      "bundle text must equal bundle.md and start with diff.patch",
    );
  }
  return { reply, diff, files: written.slice(diff.length) };
}

export {
  baseGitlink,
  mergeBranch,
  NEW_COMMIT,
  OLD_COMMIT,
  prepare,
  setGitlink,
  startBranch,
};
