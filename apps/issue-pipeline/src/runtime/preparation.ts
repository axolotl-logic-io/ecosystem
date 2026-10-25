// An action's test environment: a task that declares the `test-slot`
// resource registers its own checkout as a consumer of its issue's lane slot
// (lane-slots.ts) before the checkout exists, and its model sessions and
// ops inherit that slot as ISSUE_PIPELINE_LANE_SLOT. Closing the checkout
// (job/checkout-close.ts) releases the slot once no checkout or pending
// setup of the issue remains. A task with no test slot, or a repository
// with neither laneSlots nor a setup command, takes none of these steps.
//
// Configured teardown is not supported here yet: no guarded last-consumer
// teardown runs before checkout removal and slot release. So an acting
// test-slot task refuses before it creates any checkout or environment
// while commands.teardown is set (unsupportedTeardown), rather than leave
// resources that teardown would have freed.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import type { TaskDefinition } from "../domain.ts";
import type { JobDirs } from "../job/checkout.ts";
import { openJobCheckout } from "../job/checkout.ts";
import { checkoutEnvironment, withCheckoutSlot } from "../lane-slots.ts";
import { OpsError } from "../ops-error.ts";

const LANE_SLOT = "ISSUE_PIPELINE_LANE_SLOT";
// The config keys preparation reads; loadConfig applied their defaults.
const SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({
    setup: z.string().nullish(),
    teardown: z.string().nullish(),
  }),
});

function claimsTestSlot(task: TaskDefinition): boolean {
  return task.resources.includes("test-slot");
}

function setupCommand(cfg: Config): string | null {
  const { setup } = SETTINGS.parse(cfg).commands;
  if (setup === undefined || setup === null || setup === "") {
    return null;
  }
  return setup;
}

function teardownCommand(cfg: Config): string | null {
  const { teardown } = SETTINGS.parse(cfg).commands;
  if (teardown === undefined || teardown === null || teardown === "") {
    return null;
  }
  return teardown;
}

// Why an acting `task` may not create its test environment while
// commands.teardown is configured, or null. A refusal, not teardown: the
// configured teardown stays unsupported until a guarded last-consumer
// teardown runs before removal and release.
function unsupportedTeardown(
  cfg: Config,
  task: TaskDefinition,
  mode: "act" | "recover",
): string | null {
  if (!claimsTestSlot(task) || mode === "recover") {
    return null;
  }
  if (teardownCommand(cfg) === null) {
    return null;
  }
  return `commands.teardown is configured, but the action runtime runs no guarded last-consumer teardown yet; task ${task.id} creates no test environment that teardown could not free`;
}

// Whether the action's own checkout registers as its issue's lane-slot
// consumer: `task` holds a test slot and acts, and laneSlots is configured.
function holdsLaneSlot(
  cfg: Config,
  task: TaskDefinition,
  mode: "act" | "recover",
): boolean {
  return claimsTestSlot(task) && cfg.laneSlots !== undefined && mode === "act";
}

function setupTimeoutMinutes(cfg: Config): number {
  return SETTINGS.parse(cfg).commandTimeoutMinutes;
}

// Whether `task`'s sessions need a prepared checkout first: it holds a test
// slot and the repository configures lane slots or a setup command.
function needsPreparation(cfg: Config, task: TaskDefinition): boolean {
  return (
    claimsTestSlot(task) &&
    (cfg.laneSlots !== undefined || setupCommand(cfg) !== null)
  );
}

// Opens the action's own checkout, registered as its issue's lane-slot
// consumer first when `task` holds a test slot and acts. A read-only
// recovery takes no slot: it prepares nothing and its sessions are refused
// a test environment. A failed open keeps the registration wherever the
// checkout exists. An unsupported teardown refuses first, creating nothing.
function openActionCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; branch: string; mode: "act" | "recover" },
  task: TaskDefinition,
): JobDirs {
  const refusal = unsupportedTeardown(cfg, task, job.mode);
  if (refusal !== null) {
    throw new OpsError(refusal);
  }
  if (!holdsLaneSlot(cfg, task, job.mode)) {
    return openJobCheckout(cfg, issue, job);
  }
  const scoped = withCheckout(cfg, {
    issue,
    dir: paths.jobRepo(cfg, issue, job.stage),
    branch: job.branch,
  });
  const dirs = withCheckoutSlot(scoped, issue, () =>
    openJobCheckout(cfg, issue, job),
  );
  if (dirs === null) {
    throw new OpsError(`#${issue}'s checkout claim was cancelled`);
  }
  return dirs;
}

// The environment the action's model sessions get on top of `shared`: with
// laneSlots configured, never an inherited slot, only the slot the issue
// leases, and that only for a task holding a test slot.
function laneEnvironment(
  cfg: Config,
  issue: number,
  task: TaskDefinition,
  shared: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (cfg.laneSlots === undefined) {
    return shared;
  }
  const { [LANE_SLOT]: _inherited, ...rest } = shared;
  if (!claimsTestSlot(task)) {
    return rest;
  }
  return { ...rest, ...Object.fromEntries(checkoutEnvironment(cfg, issue)) };
}

export {
  claimsTestSlot,
  holdsLaneSlot,
  laneEnvironment,
  needsPreparation,
  openActionCheckout,
  setupCommand,
  setupTimeoutMinutes,
  unsupportedTeardown,
};
