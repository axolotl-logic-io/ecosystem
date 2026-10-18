// The configured integration branch is the only permitted PR target, even
// when a PR still has the exact authorized head. This metadata check cannot
// atomically bind GitHub's merge target: the credential must also be denied
// writes to other branches by GitHub policy, without an admin bypass.
import type { Config } from "./config.ts";
import { OpsError } from "./process.ts";

function assertPrBase(cfg: Config, pr: number, baseRefName: string): void {
  if (baseRefName !== cfg.baseBranch) {
    throw new OpsError(
      `PR #${pr} targets ${baseRefName}, not ${cfg.baseBranch}`,
    );
  }
}

export { assertPrBase };
