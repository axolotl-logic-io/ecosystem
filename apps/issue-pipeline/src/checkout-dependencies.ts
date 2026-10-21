// A retained linked worktree needs the primary clone's Git metadata. Do not
// reset or remove that clone until every registered dependent is removed.
import fs from "node:fs";
import path from "node:path";
import { gitIn } from "./git-state.ts";
import { OpsError } from "./ops-error.ts";

function assertNoDependentCheckouts(
  dir: string,
  checkouts: readonly string[],
): void {
  const metadata = path.join(dir, ".git");
  if (!fs.statSync(metadata, { throwIfNoEntry: false })?.isDirectory()) {
    return;
  }
  const primary = fs.realpathSync(metadata);
  const retained = checkouts.filter(
    (checkout) => checkout !== dir && fs.existsSync(checkout),
  );
  for (const checkout of retained) {
    let common: string;
    try {
      const reported = gitIn(checkout, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).trim();
      common = fs.realpathSync(reported);
    } catch (error) {
      throw new OpsError(
        `cannot establish Git metadata independence of retained checkout ${checkout}; preserve ${dir} and reconcile before removal`,
        { cause: error },
      );
    }
    if (common === primary) {
      throw new OpsError(
        `retained checkout ${checkout} depends on Git metadata in ${dir}; remove or recover the dependent first, keeping both checkouts and their lane slot`,
      );
    }
  }
}

export { assertNoDependentCheckouts };
