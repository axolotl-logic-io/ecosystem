// Whether GitHub enforces checks on the default branch: the required status
// checks from its branch protection and from the rulesets that apply to it.
// Reads only. A read GitHub refuses leaves enforcement unknown, never
// absent, so a green workflow can't pass for an enforced one (#129).

import { z } from "zod";
import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import type { Criterion } from "./schema.ts";

const NOT_FOUND = /\bHTTP 404\b|Not Found|not protected|not enabled/iu;
const CHECKS = z.array(z.string());
// gh's jq programs that reduce each answer to its check names.
const PROTECTION_JQ = "[(.contexts // [])[], ((.checks // [])[] | .context)]";
const RULES_JQ =
  '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context]';

// The checks a read found, an empty list when GitHub says there are none,
// or null when the read failed or its answer didn't parse.
function readChecks(
  cfg: Config,
  endpoint: string,
  jq: string,
): string[] | null {
  const args = ["api", endpoint, "--jq", jq];
  const result = gh(cfg, "merge", args, { allowFail: true });
  if (result.code !== 0) {
    if (NOT_FOUND.test(`${result.stderr}\n${result.stdout}`)) {
      return [];
    }
    return null;
  }
  try {
    return CHECKS.parse(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

// The required checks on `branch` (null when unknown) and their criterion.
function enforcementOf(
  cfg: Config,
  branch: string,
): { requiredChecks: string[] | null; criterion: Criterion } {
  const path = `repos/${cfg.repo}/branches/${encodeURIComponent(branch)}`;
  const protection = readChecks(
    cfg,
    `${path}/protection/required_status_checks`,
    PROTECTION_JQ,
  );
  const rules = readChecks(
    cfg,
    `repos/${cfg.repo}/rules/branches/${encodeURIComponent(branch)}`,
    RULES_JQ,
  );
  const found = [...new Set([...(protection ?? []), ...(rules ?? [])])].sort();
  const id = "enforcement.required-checks";
  if (found.length > 0) {
    return {
      requiredChecks: found,
      criterion: {
        id,
        status: "passed",
        evidence: `${branch} requires ${found.join(", ")}`,
      },
    };
  }
  if (protection === null || rules === null) {
    return {
      requiredChecks: null,
      criterion: {
        id,
        status: "unverified",
        evidence: `GitHub didn't show ${branch}'s branch protection and rulesets; enforcement is outstanding`,
      },
    };
  }
  return {
    requiredChecks: [],
    criterion: {
      id,
      status: "failed",
      evidence: `neither branch protection nor a ruleset requires a check on ${branch}`,
    },
  };
}

export { enforcementOf };
