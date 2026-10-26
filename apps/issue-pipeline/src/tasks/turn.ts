// Land's integration turn: the target's existing write reservation
// (execution.ts `integrationTurn`). Land takes it before its attempt is
// recorded, asserts it owns it at its push, and gives it back only once
// every Land run of the item is settled; an unsettled Land keeps it, so
// every other Land on the target waits. The turn restricts and grants
// nothing. These run in the ops child, under the action's execution.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { integrationTurn } from "../execution.ts";
import { OpsError } from "../ops-error.ts";
import type { Admission } from "./module.ts";
import { readRecords, unsettled } from "./records.ts";

type Turn = ReturnType<typeof integrationTurn>;

function instanceOf(cfg: Config): string {
  if (cfg.execution === undefined) {
    throw new OpsError("Land's integration turn needs an execution binding");
  }
  return cfg.execution.instance;
}

// Whether every Land run of the item, v2 or historical, is settled.
function landSettled(cfg: Config, number: number): boolean {
  const records = readRecords(cfg, number, listComments(cfg, number));
  return (
    records.historical.unsettledLand === null &&
    unsettled(records.rows, "land").length === 0
  );
}

// Retires what earlier invocations of this item left of the turn, once its
// Land is settled; while one is unsettled they stay and the turn holds.
// The turn's owner is one of its pending requests, so each is retired once.
function retireEarlier(cfg: Config, number: number, turn: Turn): void {
  const mine = instanceOf(cfg);
  const stale = turn
    .read()
    .pending.filter(
      (row) => row.binding.issue === number && row.binding.instance !== mine,
    );
  if (stale.length === 0 || !landSettled(cfg, number)) {
    return;
  }
  for (const row of stale) {
    turn.retire(row);
  }
}

function waitingFor(cfg: Config, turn: Turn): string {
  const { owner } = turn.read();
  if (owner === null) {
    return "the target's integration turn is not available";
  }
  if (owner.binding.instance === instanceOf(cfg)) {
    return "this action already holds the target's integration turn";
  }
  return `issue #${owner.binding.issue} holds the target's integration turn`;
}

// Takes the turn for this action, or waits with nothing recorded.
function acquireLandTurn(cfg: Config, number: number): Admission {
  const turn = integrationTurn(cfg, number);
  retireEarlier(cfg, number, turn);
  turn.request();
  if (!turn.acquire()) {
    const reason = waitingFor(cfg, turn);
    turn.cancel();
    return { state: "waiting", reason };
  }
  return { state: "admitted" };
}

// Throws unless this action owns the turn now.
function assertLandTurn(cfg: Config, number: number): void {
  const { owner } = integrationTurn(cfg, number).read();
  if (owner?.binding.instance !== instanceOf(cfg)) {
    throw new OpsError("this Land does not hold the target's integration turn");
  }
}

// Gives the turn back once every Land run of the item is settled, whether
// this action or an earlier one of the item holds it.
function releaseSettledTurn(cfg: Config, number: number): void {
  if (!landSettled(cfg, number)) {
    return;
  }
  const turn = integrationTurn(cfg, number);
  retireEarlier(cfg, number, turn);
  if (turn.read().owner?.binding.instance === instanceOf(cfg)) {
    turn.release();
  }
}

// A turn taken for an attempt that was then refused before it was recorded.
function cancelLandTurn(cfg: Config, number: number): void {
  const turn = integrationTurn(cfg, number);
  if (turn.read().owner?.binding.instance === instanceOf(cfg)) {
    turn.release();
    return;
  }
  turn.cancel();
}

export { acquireLandTurn, assertLandTurn, cancelLandTurn, releaseSettledTurn };
