// Explicit operator operations; neither is exposed as a model role tool.
// No claim, receipt, remote write, writer or retry is made here.
import { z } from "zod";
import type { Config } from "../config.ts";
import { withCheckout } from "../config.ts";
import { branchRefusalOf } from "../job/branch.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { selectLegacyWiki } from "../wiki-sync/operator.ts";
import { reconcileWikiSync } from "../wiki-sync/reconcile.ts";
import { ID, OID } from "../wiki-sync/schema.ts";

const RECOVERY_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  branch: z.string().min(1),
  lane: z.string().min(1),
  retained: z.string().min(1),
});
const RECONCILE = RECOVERY_REQUEST.extend({ id: ID });
const MIN_RATIONALE = 40;
const SELECT = RECOVERY_REQUEST.extend({
  old: OID,
  next: OID,
  target: OID,
  jobEvidence: z.string().min(1),
  rationale: z.string().min(MIN_RATIONALE),
});
function recoveryConfig(
  cfg: Config,
  req: z.infer<typeof RECOVERY_REQUEST>,
): Config {
  const refusal = branchRefusalOf(cfg, req.number, req.branch, false);
  if (refusal !== null) {
    throw new OpsError(refusal);
  }
  return {
    ...withCheckout(cfg, {
      issue: req.number,
      dir: req.retained,
      branch: req.branch,
    }),
    recoveryLane: req.lane,
  };
}
function reconcileWiki(
  cfg: Config,
  request: unknown,
): ReturnType<typeof reconcileWikiSync> {
  const req = parseRequest(RECONCILE, "reconcile-wiki-sync", request);
  return reconcileWikiSync(recoveryConfig(cfg, req), req);
}
function selectWiki(
  cfg: Config,
  request: unknown,
): ReturnType<typeof selectLegacyWiki> {
  const req = parseRequest(SELECT, "select-wiki-recovery", request);
  return selectLegacyWiki(recoveryConfig(cfg, req), req);
}

export { reconcileWiki, selectWiki };
