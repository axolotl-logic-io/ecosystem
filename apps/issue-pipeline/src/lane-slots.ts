// Warm test environments belong to actual issue checkouts, not expiring job
// processes or GitHub claims. The clone lock serializes allocation, checkout
// creation/removal and maintenance; the durable record survives an ops crash.
import fs from "node:fs";
import { assertNoDependentCheckouts } from "./checkout-dependencies.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import {
  readStore,
  saveStore,
  storeFile,
  surviving,
} from "./lane-slot-store.ts";
import { withCloneLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import type { ShellResult } from "./process.ts";

// Calls claim under the clone lock with capacity reserved before any claim
// mutation. Null means the claim lost and cancels only this reservation.
// Exceptions/crashes retain ownership wherever a checkout still exists.
function withCheckoutSlot<T>(
  cfg: Config,
  issue: number,
  claim: () => T | null,
): T | null {
  const { laneSlots } = cfg;
  if (laneSlots === undefined) {
    return claim();
  }
  return withCloneLock(cfg, () => {
    const before = surviving(readStore(cfg));
    const held = before.leases.find((lease) => lease.issue === issue);
    if (held !== undefined && held.slot > laneSlots) {
      throw new OpsError(
        `#${issue} retains lane slot ${held.slot} outside laneSlots=${laneSlots}; drain and remove its checkouts or restore the pool before retrying`,
      );
    }
    const occupied = new Set(before.leases.map((lease) => lease.slot));
    let slot = held?.slot;
    for (
      let candidate = 1;
      slot === undefined && candidate <= laneSlots;
      candidate += 1
    ) {
      if (!occupied.has(candidate)) {
        slot = candidate;
      }
    }
    if (slot === undefined) {
      throw new OpsError(
        `no free lane slot (laneSlots=${laneSlots}); retry after an issue checkout is removed`,
      );
    }
    const checkouts = new Set(held?.checkouts ?? []);
    checkouts.add(paths.worktree(cfg, issue));
    const reservation = {
      issue,
      slot,
      checkouts: [...checkouts],
      pendingSetup: held?.pendingSetup ?? [],
    };
    saveStore(cfg, {
      ...before,
      leases: [
        ...before.leases.filter((item) => item.issue !== issue),
        reservation,
      ],
    });
    const result = claim();
    if (result === null) {
      saveStore(cfg, before);
    }
    return result;
  });
}

// Called after actual removal, under the same lock as that removal. Surviving
// recovery or other-stage checkouts keep their issue's slot; patches do not.
function releaseCheckoutSlot(cfg: Config): void {
  withCloneLock(cfg, () => {
    if (fs.existsSync(storeFile(cfg))) {
      saveStore(cfg, surviving(readStore(cfg)));
    }
  });
}

// Secondary verification checkouts use their issue's existing environment,
// never a second slot. This accessor cannot allocate or silently use defaults.
function checkoutEnvironment(
  cfg: Config,
  issue: number,
): ReadonlyMap<string, string> {
  if (cfg.laneSlots === undefined) {
    return new Map();
  }
  return withCloneLock(cfg, () => {
    const held = surviving(readStore(cfg)).leases.find(
      (lease) => lease.issue === issue,
    );
    if (held === undefined || held.slot > (cfg.laneSlots ?? 0)) {
      throw new OpsError(
        `#${issue} has no usable lane slot; claim its checkout before setup or verification`,
      );
    }
    return new Map([["ISSUE_PIPELINE_LANE_SLOT", String(held.slot)]]);
  });
}

// Recovery may name the same checkout through a symlink or platform alias.
function sameCheckout(left: string, right: string): boolean {
  return (
    left === right ||
    (fs.existsSync(left) &&
      fs.existsSync(right) &&
      fs.realpathSync(left) === fs.realpathSync(right))
  );
}

// A failed or interrupted lane setup cannot fall back to a human/default
// environment. Mark it before launch and keep the original checkout until an
// explicit successful retry; this is local readiness, not signed authority.
function withCheckoutSetup(
  cfg: Config,
  issue: number,
  dir: string,
  setup: (env: ReadonlyMap<string, string>) => ShellResult,
): ShellResult {
  if (cfg.laneSlots === undefined) {
    return setup(new Map());
  }
  const env = checkoutEnvironment(cfg, issue);
  withCloneLock(cfg, () => {
    const store = readStore(cfg);
    const held = store.leases.find((lease) => lease.issue === issue);
    if (held === undefined) {
      throw new OpsError(`#${issue} has no lane slot; claim before setup`);
    }
    held.pendingSetup = [...new Set([...held.pendingSetup, dir])];
    saveStore(cfg, store);
  });
  const result = setup(env);
  if (result.code !== 0) {
    throw new OpsError(
      `#${issue} lane setup failed (exit ${result.code}); checkout retained at ${dir}. Inspect ${String(result.log)}, fix setup and explicitly retry the claim before starting tests`,
    );
  }
  withCloneLock(cfg, () => {
    const store = readStore(cfg);
    const held = store.leases.find((lease) => lease.issue === issue);
    if (held === undefined) {
      throw new OpsError(
        `#${issue} lost lane slot ownership during setup; retain ${dir} and reconcile`,
      );
    }
    held.pendingSetup = held.pendingSetup.filter(
      (pending) => !sameCheckout(pending, dir),
    );
    saveStore(cfg, store);
  });
  return result;
}

// Missing or corrupt ownership cannot prove setup readiness. This guard
// checks the durable barrier even when the setup command is now absent.
function assertCheckoutReady(cfg: Config, issue: number, dir: string): void {
  if (cfg.laneSlots === undefined) {
    return;
  }
  withCloneLock(cfg, () => {
    if (!fs.existsSync(storeFile(cfg))) {
      throw new OpsError(
        `lane slot ownership is missing; retain ${dir} and reconcile before tests or removal`,
      );
    }
    const held = readStore(cfg).leases.find((lease) => lease.issue === issue);
    if (held?.pendingSetup.some((pending) => sameCheckout(pending, dir))) {
      throw new OpsError(
        `lane setup is incomplete; checkout retained at ${dir}. Fix setup and explicitly retry the claim before tests or removal`,
      );
    }
  });
}

// Also preserve Git metadata needed by another surviving checkout.
function assertCheckoutReadyForRemoval(
  cfg: Config,
  issue: number,
  dir: string,
): void {
  if (cfg.laneSlots === undefined) {
    return;
  }
  withCloneLock(cfg, () => {
    assertCheckoutReady(cfg, issue, dir);
    const held = surviving(readStore(cfg)).leases.find(
      (lease) => lease.issue === issue,
    );
    if (held !== undefined) {
      assertNoDependentCheckouts(dir, held.checkouts);
    }
  });
}

// The removal guard for a checkout that never registered as a lane-slot
// consumer (Land, a read-only recovery, a task with no test slot).
// With no lane store at all, nothing is registered, so nothing can be
// pending on it or depend on its metadata; otherwise the full guard holds.
function assertNonconsumerReadyForRemoval(
  cfg: Config,
  issue: number,
  dir: string,
): void {
  if (cfg.laneSlots === undefined) {
    return;
  }
  withCloneLock(cfg, () => {
    if (fs.existsSync(storeFile(cfg))) {
      assertCheckoutReadyForRemoval(cfg, issue, dir);
    }
  });
}

// The registered consumers of issue `issue`'s lane slot other than checkout
// `except`: its other surviving checkouts and every pending setup. The slot
// stays held while any is left (capacity-by-resource); an unreadable store
// throws, since an unknown consumer state holds too.
function registeredConsumers(
  cfg: Config,
  issue: number,
  except: string | null,
): string[] {
  if (cfg.laneSlots === undefined) {
    return [];
  }
  return withCloneLock(cfg, () => {
    const held = surviving(readStore(cfg)).leases.find(
      (lease) => lease.issue === issue,
    );
    if (held === undefined) {
      return [];
    }
    const others = held.checkouts.filter(
      (dir) => except === null || !sameCheckout(dir, except),
    );
    return [...others, ...held.pendingSetup];
  });
}

export {
  assertCheckoutReady,
  assertCheckoutReadyForRemoval,
  assertNonconsumerReadyForRemoval,
  checkoutEnvironment,
  registeredConsumers,
  releaseCheckoutSlot,
  withCheckoutSetup,
  withCheckoutSlot,
};
