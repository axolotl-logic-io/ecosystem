// The buddy runtime's one cooperative stop, scoped to the buddy run or to a
// single work item. SIGTERM or SIGINT stops the whole run; an accepted stop
// signal on a work item (signals' stopLatch) stops only that item's action,
// never another item's. A stop only closes admission: no new action,
// model session or op starts in its scope, and a live model session is
// asked to abort at its next safe boundary. Nothing here signals or kills a
// process, so a credentialed write, a Git rebase or a Land already in flight
// runs to its own end. Escalation stays the operator's explicit process
// safety valve (SIGKILL), never this stop.

import process from "node:process";
import type { WorkItemRef } from "../domain.ts";
import type { StopObservation } from "./observations.ts";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

interface StopControl {
  // Aborts once the whole buddy run is stopping.
  buddy: AbortSignal;
  // The stop of the whole run, or null while it runs on.
  buddyStop: () => StopObservation | null;
  // Stops the whole run with `reason`; a second stop changes nothing.
  stopBuddy: (reason: string) => void;
  // Aborts once `item` or the whole run is stopping.
  forWorkItem: (item: WorkItemRef) => AbortSignal;
  // Stops `item` alone with `reason`.
  stopWorkItem: (item: WorkItemRef, reason: string) => void;
  // The stop that applies to `item`: the run's, else its own, else null.
  stopOf: (item: WorkItemRef) => StopObservation | null;
  // Removes the signal handlers.
  close: () => void;
}

function itemKey(item: WorkItemRef): string {
  return `${item.repo.toLowerCase()}#${item.number}`;
}

// Opens the run's stop control and listens for SIGTERM and SIGINT, which
// stop the whole run. A signal while already stopping only says so.
function openStop(): StopControl {
  const run = new AbortController();
  let runStop: StopObservation | null = null;
  const items = new Map<
    string,
    { controller: AbortController; stop: StopObservation | null }
  >();
  function itemOf(item: WorkItemRef): {
    controller: AbortController;
    stop: StopObservation | null;
  } {
    const key = itemKey(item);
    const found = items.get(key);
    if (found !== undefined) {
      return found;
    }
    const made = { controller: new AbortController(), stop: null };
    items.set(key, made);
    return made;
  }
  function stopBuddy(reason: string): void {
    if (runStop !== null) {
      return;
    }
    runStop = {
      scope: "buddy",
      reason,
      requestedAt: new Date().toISOString(),
    };
    run.abort(reason);
  }
  function onSignal(signal: (typeof SIGNALS)[number]): void {
    if (runStop !== null) {
      process.stderr.write(
        "buddy: already stopping; in-flight writes, rebases and Lands finish first (escalate only with SIGKILL)\n",
      );
      return;
    }
    stopBuddy(`${signal} received`);
  }
  for (const signal of SIGNALS) {
    process.on(signal, onSignal);
  }
  return {
    buddy: run.signal,
    buddyStop: (): StopObservation | null => runStop,
    stopBuddy,
    forWorkItem: (item: WorkItemRef): AbortSignal =>
      AbortSignal.any([run.signal, itemOf(item).controller.signal]),
    stopWorkItem: (item: WorkItemRef, reason: string): void => {
      const entry = itemOf(item);
      if (entry.stop !== null) {
        return;
      }
      entry.stop = {
        scope: "work-item",
        reason,
        requestedAt: new Date().toISOString(),
      };
      entry.controller.abort(reason);
    },
    stopOf: (item: WorkItemRef): StopObservation | null =>
      runStop ?? items.get(itemKey(item))?.stop ?? null,
    close: (): void => {
      for (const signal of SIGNALS) {
        process.off(signal, onSignal);
      }
    },
  };
}

// Resolves after `ms`, or as soon as `signal` aborts.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void): void => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type { StopControl };
export { openStop, pause };
