// @ts-check
import fs from "node:fs";
import path from "node:path";
import { git, headOf } from "./pipeline-commit-test-kit.mjs";

const READ_ONLY = Object.fromEntries([["GIT_OPTIONAL_LOCKS", "0"]]);

/** @param {string} dir */
function checkoutSnapshot(dir) {
  const index = path.resolve(
    dir,
    git(dir, ["rev-parse", "--git-path", "index"]),
  );
  return {
    head: headOf(dir),
    index: fs.readFileSync(index).toString("hex"),
    status: git(
      dir,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      READ_ONLY,
    ),
    diff: git(dir, ["diff", "--binary"], READ_ONLY),
  };
}

/** @param {{repo: string, docs: string}} job */
function snapshot(job) {
  return [checkoutSnapshot(job.repo), checkoutSnapshot(job.docs)];
}

export { snapshot };
