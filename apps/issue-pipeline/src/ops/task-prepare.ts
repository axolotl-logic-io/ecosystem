// `prepare-checkout`: the configured setup in a buddy action's own checkout,
// with its issue's leased lane slot (lane-slots.ts). Request `{number}`;
// reply `{prepared, log}`, the checkout and its setup log in the issue's
// run folder. The task guard checked the buddy's authorization,
// the stop latch and the action's cause as this op began; it checks the
// issue's execution is still the action's right before setup runs. Setup
// runs under the shell supervisor in this ops child, so the buddy keeps
// answering stops while it runs. A failed setup leaves the checkout's
// pending-setup barrier in the lane store, which holds the checkout, its
// slot and the issue until an explicit successful retry.

import { z } from "zod";
import { setUpCheckout } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { issueExecution } from "../execution.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";

const REQUEST = z.looseObject({ number: z.number().int().positive() });

function prepareCheckout(
  cfg: Config,
  request: unknown,
): { prepared: string; log: string } {
  const { number } = parseRequest(REQUEST, "prepare-checkout", request);
  const { checkout, execution } = cfg;
  if (checkout?.issue !== number || execution === undefined) {
    throw new OpsError(
      "prepare-checkout runs only in its bound action's own checkout",
    );
  }
  issueExecution(cfg, number).assertOwner();
  const logName = `setup-${execution.instance}.log`;
  setUpCheckout(cfg, number, checkout.dir, logName);
  return { prepared: checkout.dir, log: logName };
}

export { prepareCheckout };
