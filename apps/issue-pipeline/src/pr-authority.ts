// The configured integration branch is the only permitted PR target, even
// when a PR still has the exact authorized head. This metadata check cannot
// atomically bind current PR state. The merge mutation separately names
// the configured destination and immutable authorized source.
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
