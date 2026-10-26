// `prepare-checkout`: the configured setup in a buddy action's own checkout,
// with its issue's leased lane slot (lane-slots.ts). Request `{number}`;
// reply `{prepared, log}`, the checkout and its setup log in the issue's
// run folder. The task guard checked the buddy's authorization,
// the stop latch and the action's cause as this op began. The op itself
// then requires, from the work item's records read fresh here, that this
// action is the original unsettled act attempt of a task that declares the
// `test-slot` resource: a read-only recovery records no attempt, a finished
// run is settled, and Land declares no test slot. It checks the
// issue's execution is still the action's right before setup runs.
//
// Setup runs at most once per action: a start marker is created
// exclusively before setup, so a replay of a started, failed or finished
// setup is refused. The marker only refuses; it grants no readiness or
// task success. Setup runs under the shell supervisor in this ops child, so
// the buddy keeps answering stops while it runs. A failed setup throws,
// with or without laneSlots; with laneSlots it also leaves the checkout's
// pending-setup barrier in the lane store, which holds the checkout, its
// slot and the issue for explicit reconciliation.

import { z } from "zod";
import { claimSetupStart, setUpCheckout } from "../checkouts.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { issueExecution } from "../execution.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { unsupportedTeardown } from "../runtime/preparation.ts";
import { MODULES } from "../tasks/modules.ts";
import { isAttempt, readRecords, statusOf } from "../tasks/records.ts";

const OP = "prepare-checkout";
const REQUEST = z.looseObject({ number: z.number().int().positive() });

function refuse(reason: string): never {
  throw new OpsError(`${OP} refused: ${reason}`);
}

// Refuses unless action `run` is the original unsettled act attempt of a
// task that declares a test slot.
function assertPreparingAttempt(
  cfg: Config,
  number: number,
  run: string,
): void {
  const { rows } = readRecords(cfg, number, listComments(cfg, number));
  const attempt = rows.filter(isAttempt).find((row) => row.run.id === run);
  if (attempt === undefined) {
    refuse(`action ${run} has no recorded attempt; recovery prepares nothing`);
  }
  const { definition } = MODULES[attempt.binding.task];
  if (!definition.resources.includes("test-slot")) {
    refuse(`task ${definition.id} declares no test slot to prepare`);
  }
  const status = statusOf(rows, attempt.binding);
  if (status.status !== "unknown" || status.attempt.run.id !== run) {
    refuse(`action ${run} is not its binding's unsettled run`);
  }
  const teardown = unsupportedTeardown(cfg, definition, "act");
  if (teardown !== null) {
    refuse(teardown);
  }
}

function prepareCheckout(
  cfg: Config,
  request: unknown,
): { prepared: string; log: string } {
  const { number } = parseRequest(REQUEST, OP, request);
  const { checkout, execution } = cfg;
  if (checkout?.issue !== number || execution === undefined) {
    refuse("it runs only in its bound action's own checkout");
  }
  assertPreparingAttempt(cfg, number, execution.instance);
  issueExecution(cfg, number).assertOwner();
  if (!claimSetupStart(cfg, number, execution.instance)) {
    refuse(
      `action ${execution.instance}'s setup already started; it is not replayed`,
    );
  }
  const logName = `setup-${execution.instance}.log`;
  setUpCheckout(cfg, number, checkout.dir, logName);
  return { prepared: checkout.dir, log: logName };
}

export { prepareCheckout };
