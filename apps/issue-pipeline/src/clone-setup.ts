// Compatibility host chooses commit identity and credentialed submodule access.
import {
  configureClone as configure,
  updateSubmodules as update,
} from "@ecosystem/task-runtime/clone-setup";
import type { Config } from "./config.ts";
import { checkoutAccess } from "./job/checkout.ts";

function configureClone(cfg: Config, clone: string): void {
  configure(
    {
      name: cfg.gitName || cfg.devAccount,
      email: cfg.gitEmail || `${cfg.devAccount}@users.noreply.github.com`,
    },
    clone,
  );
}
function updateSubmodules(cfg: Config, dir: string): void {
  update(checkoutAccess(cfg), dir);
}

export { configureClone, updateSubmodules };
