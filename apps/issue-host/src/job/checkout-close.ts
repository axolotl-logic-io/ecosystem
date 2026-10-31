// Closes a job checkout with the host's private layout and credentialed Git
// operations.

import type {
  ClosingJob,
  DroppedChanges,
} from "@ecosystem/task-runtime/job/checkout-close";
import { closeJobCheckout as closeCheckout } from "@ecosystem/task-runtime/job/checkout-close";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { checkoutAccess } from "./checkout.ts";

function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: ClosingJob,
  push: (() => Promise<void>) | null,
): Promise<DroppedChanges> {
  return closeCheckout(
    { artifacts: paths.runDir(cfg, issue), repository: cfg.repo, issue },
    job,
    push,
    checkoutAccess(cfg),
  );
}

export { closeJobCheckout };
