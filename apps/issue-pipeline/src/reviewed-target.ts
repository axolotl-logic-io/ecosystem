// A target observed during hardening is part of that authorization, not a
// value that a later merge may replace with any currently advertised ancestor.
import { z } from "zod";
import type { Config } from "./config.ts";

const TARGET_SHA = /^[0-9a-f]{40}$/u;
const REVIEWED_TARGET = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1),
  sha: z.string().regex(TARGET_SHA),
});
type ReviewedTarget = z.infer<typeof REVIEWED_TARGET>;

function reviewedTarget(cfg: Config, sha: string): ReviewedTarget {
  return REVIEWED_TARGET.parse({ repo: cfg.repo, branch: cfg.baseBranch, sha });
}

function targetHolds(
  cfg: Pick<Config, "repo" | "baseBranch">,
  target: ReviewedTarget | null | undefined,
  sha: string,
): boolean {
  return (
    target !== null &&
    target !== undefined &&
    target.repo === cfg.repo &&
    target.branch === cfg.baseBranch &&
    target.sha === sha
  );
}

export type { ReviewedTarget };
export { REVIEWED_TARGET, reviewedTarget, targetHolds };
