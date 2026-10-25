// Required CI on exactly revision R, read fresh for Land's prerequisite
// (tasks/land.ts) at attempt admission and again in its effect: the item's
// one PR must have R as its head before and after its required checks are
// read, and none of them may be failing or pending. With `requireCi`, no
// required check at all is unmet too. An unreadable or malformed answer is
// unmet and says so; it never reads as no checks or a pass.

import { z } from "zod";
import type { Config } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import type { Check } from "./ci-status.ts";
import { CHECKS, isFailing } from "./ci-status.ts";
import { historicalPrFor } from "./prs.ts";

const HEAD = z.looseObject({ headRefOid: z.string() });
// The policy setting, read strictly: a config that does not say leaves CI
// unreadable rather than waived.
const POLICY = z.looseObject({ requireCi: z.boolean() });
// What gh prints, on stderr, for a PR with no required checks.
const NO_CHECKS = /no (?:required )?checks reported/iu;

type Read = { checks: Check[] } | { unreadable: string };

function headOf(cfg: Config, pr: number): string {
  const view = ghJson(cfg, "landing", [
    "pr",
    "view",
    String(pr),
    "-R",
    cfg.repo,
    "--json",
    "headRefOid",
  ]);
  return HEAD.parse(view).headRefOid;
}

// The PR's required checks: gh exits non-zero for failing (1) or pending
// (8) checks while still printing them.
function readChecks(cfg: Config, pr: number): Read {
  const result = gh(
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
      "name,state,bucket,link",
    ],
    { allowFail: true },
  );
  if (result.stdout.trim() === "" && NO_CHECKS.test(result.stderr)) {
    return { checks: [] };
  }
  try {
    const parsed = CHECKS.safeParse(JSON.parse(result.stdout));
    if (parsed.success) {
      return { checks: parsed.data };
    }
    return { unreadable: parsed.error.message };
  } catch {
    return { unreadable: `gh exited ${result.code} without a check list` };
  }
}

function checksUnmet(
  cfg: Config,
  pr: number,
  code: string,
  checks: readonly Check[],
): string | null {
  const failing = checks.filter(isFailing).map((check) => check.name);
  if (failing.length > 0) {
    return `the required CI checks ${failing.join(", ")} failed on ${code}`;
  }
  if (
    checks.some(
      (check) => check.bucket !== "pass" && check.bucket !== "skipping",
    )
  ) {
    return `required CI is still running on ${code}`;
  }
  if (checks.length === 0 && POLICY.parse(cfg).requireCi) {
    return `CI is required, and PR #${pr} has no required CI checks on ${code}`;
  }
  return null;
}

function unmetOn(cfg: Config, number: number, code: string): string | null {
  const pr = historicalPrFor(cfg, number);
  if (pr === null) {
    if (POLICY.parse(cfg).requireCi) {
      return `CI is required, and #${number} has no PR to read it from`;
    }
    return null;
  }
  const before = headOf(cfg, pr);
  if (before !== code) {
    return `PR #${pr}'s head is ${before}, not ${code}`;
  }
  const read = readChecks(cfg, pr);
  const after = headOf(cfg, pr);
  if (after !== code) {
    return `PR #${pr}'s head moved to ${after} while its CI was read`;
  }
  if ("unreadable" in read) {
    return `the required CI of PR #${pr} is unreadable: ${read.unreadable}`;
  }
  return checksUnmet(cfg, pr, code, read.checks);
}

// Why required CI does not clear `code` for issue `number`, or null.
function requiredCiUnmet(
  cfg: Config,
  number: number,
  code: string,
): string | null {
  try {
    return unmetOn(cfg, number, code);
  } catch (error) {
    if (error instanceof Error) {
      return `the required CI of #${number} is unreadable: ${error.message}`;
    }
    throw error;
  }
}

export { requiredCiUnmet };
