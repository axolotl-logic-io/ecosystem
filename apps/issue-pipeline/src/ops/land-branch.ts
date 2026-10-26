// The sole target mutation: a strict fast-forward with an explicit old-OID
// lease. The lease is server CAS, not permission to replace non-ancestor work.
// No fallback or retry is safe, including after an ambiguous transport error.
import { z } from "zod";
import type { Config } from "../config.ts";
import { assertGitPushDestination } from "../git-remote.ts";
import { gitIn } from "../git-state.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";

const FULL_SHA = z.string().regex(/^[0-9a-f]{40}$/u);

function targetRef(cfg: Config): string {
  const ref = `refs/heads/${cfg.baseBranch}`;
  if (
    cfg.baseBranch.startsWith("-") ||
    run("git", ["check-ref-format", ref], { allowFail: true }).code !== 0
  ) {
    throw new OpsError(
      "fast-forward requires a literal configured target branch",
    );
  }
  return ref;
}

function assertFastForward(wt: string, base: string, head: string): void {
  FULL_SHA.parse(base);
  FULL_SHA.parse(head);
  for (const sha of [base, head]) {
    if (gitIn(wt, ["cat-file", "-t", sha]).trim() !== "commit") {
      throw new OpsError("fast-forward old and new IDs must name commits");
    }
  }
  if (
    base === head ||
    run("git", ["-C", wt, "merge-base", "--is-ancestor", base, head], {
      allowFail: true,
    }).code !== 0
  ) {
    throw new OpsError("fast-forward requires a strict ancestor old target");
  }
}

function landBranch(
  cfg: Config,
  wt: string,
  base: string,
  head: string,
): boolean {
  const ref = targetRef(cfg);
  assertFastForward(wt, base, head);
  assertGitPushDestination(cfg, wt);
  const result = git(
    cfg,
    "landing",
    [
      "-C",
      wt,
      "-c",
      "push.followTags=false",
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--porcelain",
      `--force-with-lease=${ref}:${base}`,
      "origin",
      `${head}:${ref}`,
    ],
    // The Land attempt recorded before this push reconciles it.
    { allowFail: true, reconciles: true },
  );
  // Acknowledgement is only response evidence, never a confirmed receipt.
  return result.code === 0;
}

export { assertFastForward, landBranch, targetRef };
