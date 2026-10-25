// The repository/target integration turn around an exact Land (#171): a
// reservation of the target's writes, in the integration scope of the
// coordination protocol (src/execution.ts `integrationTurn`). Land requests
// and acquires it before its attempt record and its first PR or target
// write, and rereads the target under it. A Land that doesn't get the turn
// cancels its request and writes nothing; the caller's merge queue keeps the
// order across retries. The turn adds a restriction and grants nothing:
// every read and write of it first asserts the issue's confirmed execution,
// and the exact Land checks all still apply.
//
// The turn is released only once its consumer, the issue's Land, is done
// (capacity-by-resource): settled, or never attempted. While a Land attempt
// is unsettled the turn stays held, and every other Land on the target
// waits. A later invocation of the same issue that finds the Land settled
// retires the earlier invocation's request.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { Request } from "../coordination.ts";
import { integrationTurn } from "../execution.ts";
import { fetchIn, gitIn } from "../git-state.ts";
import { OpsError } from "../ops-error.ts";
import { taskRecords, unsettledAttempts } from "../task-results.ts";

type Turn = ReturnType<typeof integrationTurn>;

// A refused Land's reply when another Land holds the turn.
interface TurnHeld {
  merged: false;
  reason: "integration-turn";
  detail: string;
}

// Whether every Land attempt of the issue has a settled verdict.
function landSettled(cfg: Config, number: number): boolean {
  const rows = taskRecords(cfg, number, listComments(cfg, number));
  return unsettledAttempts(rows, "Land").length === 0;
}

// The turn's requests left by earlier invocations of this issue.
function earlier(cfg: Config, number: number, turn: Turn): Request[] {
  return turn
    .read()
    .pending.filter(
      (row) =>
        row.identity.issue === number &&
        row.identity.instance !== cfg.execution?.instance,
    );
}

// Retires earlier invocations' requests of this issue once its Land is
// settled; while one is unsettled, they stay and the turn holds.
function retireEarlier(cfg: Config, number: number, turn: Turn): void {
  const stale = earlier(cfg, number, turn);
  if (stale.length === 0 || !landSettled(cfg, number)) {
    return;
  }
  for (const row of stale) {
    turn.retire(row);
  }
}

// After a replay or reconciliation settles the Land: retire what an earlier
// invocation of this issue left of the turn. A request without a binding
// can't write, so it leaves the turn alone.
function retireSettledTurn(cfg: Config, number: number): void {
  if (cfg.execution !== undefined) {
    retireEarlier(cfg, number, integrationTurn(cfg, number));
  }
}

// Why this Land waits: who holds the turn, and every request ahead of it.
function waitingFor(cfg: Config, turn: Turn): string {
  const { owner, pending } = turn.read();
  const mine = pending.findIndex(
    (row) => row.identity.instance === cfg.execution?.instance,
  );
  const ahead = pending.slice(0, mine).map((row) => `#${row.identity.issue}`);
  let holder = "no Land holds the target's integration turn";
  if (owner !== null) {
    holder = `issue #${owner.identity.issue} holds the target's integration turn`;
  }
  return `${holder}; ahead of this Land: ${ahead.join(", ")}`;
}

// The target's commit on the remote, read afresh.
function targetNow(cfg: Config, number: number): string {
  const wt = paths.worktree(cfg, number);
  fetchIn(cfg, wt, cfg.baseBranch);
  return gitIn(wt, ["rev-parse", `origin/${cfg.baseBranch}`]).trim();
}

// Releases the turn once the Land is done. On a failed Land a release that
// can't be made leaves the turn held, and the Land's own error says why.
function releaseIfDone(
  cfg: Config,
  number: number,
  turn: Turn,
  failing: boolean,
): void {
  try {
    if (landSettled(cfg, number)) {
      turn.release();
    }
  } catch (error) {
    if (!failing) {
      throw error;
    }
  }
}

// Runs `land` under the integration turn of the target, or refuses it with
// no write when another Land holds the turn or the target moved.
function underTurn<T>(
  cfg: Config,
  req: { number: number; expectedBase: string },
  land: () => T,
): T | TurnHeld | { merged: false; reason: "target-changed" } {
  if (cfg.execution === undefined) {
    throw new OpsError("an exact Land needs an invocation binding");
  }
  const turn = integrationTurn(cfg, req.number);
  retireEarlier(cfg, req.number, turn);
  turn.request();
  if (!turn.acquire()) {
    const detail = waitingFor(cfg, turn);
    turn.cancel();
    return { merged: false, reason: "integration-turn", detail };
  }
  if (targetNow(cfg, req.number) !== req.expectedBase) {
    turn.release();
    return { merged: false, reason: "target-changed" };
  }
  let reply: T;
  try {
    reply = land();
  } catch (error) {
    releaseIfDone(cfg, req.number, turn, true);
    throw error;
  }
  releaseIfDone(cfg, req.number, turn, false);
  return reply;
}

export type { TurnHeld };
export { retireSettledTurn, underTurn };
