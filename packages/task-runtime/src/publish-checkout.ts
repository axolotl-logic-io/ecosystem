// Validate retained work and ancestry before granting a remote effect.
import { run } from "./command.ts";
import { OpsError } from "./ops-error.ts";

interface CheckoutPublication {
  repository: string;
  branch: string;
  expectedHead: string;
  baseHead: string;
}
interface PublicationAuthority {
  checkStop: () => void;
  push: (args: readonly string[]) => void;
}
const COMMIT_ENV = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["GIT_EDITOR", "true"],
]);
function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args], { cwd: dir }).stdout;
}
function publishCheckout(
  checkout: CheckoutPublication,
  authority: PublicationAuthority,
): string {
  authority.checkStop();
  const merging = run(
    "git",
    ["-C", checkout.repository, "rev-parse", "--verify", "MERGE_HEAD"],
    { allowFail: true },
  );
  if (merging.code === 0) {
    if (
      gitIn(checkout.repository, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]).trim() !== ""
    ) {
      throw new OpsError("the base merge still has unresolved conflicts");
    }
    gitIn(checkout.repository, ["diff", "--cached", "--check"]);
    run("git", ["-C", checkout.repository, "commit", "--no-edit"], {
      env: COMMIT_ENV,
    });
  }
  if (
    gitIn(checkout.repository, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]).trim() !== ""
  ) {
    throw new OpsError("writer left uncommitted files; checkout retained");
  }
  const sha = gitIn(checkout.repository, ["rev-parse", "HEAD"]).trim();
  for (const ancestor of [checkout.expectedHead, checkout.baseHead]) {
    gitIn(checkout.repository, ["merge-base", "--is-ancestor", ancestor, sha]);
  }
  gitIn(checkout.repository, [
    "diff",
    "--check",
    `${checkout.baseHead}...${sha}`,
  ]);
  // The checkout hook admits only this command; credentials never reach pi.
  authority.checkStop();
  authority.push([
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    checkout.repository,
    "push",
    "origin",
    `HEAD:refs/heads/${checkout.branch}`,
  ]);
  return sha;
}

export type { CheckoutPublication, PublicationAuthority };
export { publishCheckout };
