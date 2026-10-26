// What Verify makes of the required CI on exactly one PR head: clear, still
// running, failing, or unjudged. The whole judgment is required-ci.ts's;
// only when it is unmet does one more read of the PR's required checks say
// why. Failing checks are a change the head needs, so they block its
// review. Checks still running are no verdict yet; neither is anything else
// (an unreadable answer, a moved head, CI required with none reported), so
// Verify waits for a verdict before it attempts the head, and a run that
// meets one anyway can't judge it.

import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import type { Check } from "./ci-status.ts";
import { CHECKS, isFailing } from "./ci-status.ts";
import { historicalPrFor } from "./prs.ts";
import { requiredCiUnmet } from "./required-ci.ts";

type CiReading =
  | { state: "clear" }
  | { state: "pending" | "failing" | "unjudged"; reason: string };

// The PR's required checks as gh reports them now, or null when they can't
// be read.
function checksNow(cfg: Config, number: number): Check[] | null {
  try {
    const pr = historicalPrFor(cfg, number);
    if (pr === null) {
      return null;
    }
    const read = gh(
      cfg,
      "landing",
      [
        "pr",
        "checks",
        String(pr),
        "-R",
        cfg.repo,
        "--required",
        "--json",
        "name,bucket",
      ],
      { allowFail: true },
    );
    const parsed = CHECKS.safeParse(JSON.parse(read.stdout));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// The required CI of issue `number` on exactly `code`.
function requiredCi(cfg: Config, number: number, code: string): CiReading {
  const unmet = requiredCiUnmet(cfg, number, code);
  if (unmet === null) {
    return { state: "clear" };
  }
  const read = checksNow(cfg, number) ?? [];
  if (read.some(isFailing)) {
    return { state: "failing", reason: unmet };
  }
  if (read.some((check) => check.bucket === "pending")) {
    return { state: "pending", reason: unmet };
  }
  return { state: "unjudged", reason: unmet };
}

// Why Verify should wait before it reviews `code`, or null once required CI
// has a verdict on it: clear or failing. CI still running, or not yet
// reported on a head just pushed, is no verdict, and neither is an answer
// that can't be read; waiting records nothing, so a later poll looks again.
function ciUnsettled(cfg: Config, number: number, code: string): string | null {
  const reading = requiredCi(cfg, number, code);
  if (reading.state === "pending" || reading.state === "unjudged") {
    return reading.reason;
  }
  return null;
}

export type { CiReading };
export { ciUnsettled, requiredCi };
