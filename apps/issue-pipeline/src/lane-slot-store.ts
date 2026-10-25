// Durable local lane ownership. Callers serialize reads and writes with the
// clone lock; this module owns validation, atomic replacement and path liveness.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { MAX_LANE_SLOTS } from "./config-schema.ts";
import { OpsError } from "./ops-error.ts";

const SLOT = z.number().int().min(1).max(MAX_LANE_SLOTS);
const LEASE = z.object({
  issue: z.number().int().positive(),
  slot: SLOT,
  checkouts: z.array(z.string().min(1)).min(1),
  pendingSetup: z.array(z.string().min(1)).default([]),
});
const STORE = z
  .object({
    leases: z.array(LEASE),
    prunedAt: z.number().finite().nullable(),
  })
  .refine(
    ({ leases }) =>
      new Set(leases.map((lease) => lease.issue)).size === leases.length &&
      new Set(leases.map((lease) => lease.slot)).size === leases.length,
    "duplicate issue or slot ownership",
  );

type SlotStore = z.infer<typeof STORE>;

function storeFile(cfg: Config): string {
  return path.join(path.dirname(paths.runDir(cfg, 0)), "lane-slots.json");
}

function readStore(cfg: Config): SlotStore {
  const file = storeFile(cfg);
  if (!fs.existsSync(file)) {
    return { leases: [], prunedAt: null };
  }
  try {
    return STORE.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new OpsError(
      `cannot read lane slot ownership at ${file}; preserve checkouts and reconcile before retrying`,
      { cause: error },
    );
  }
}

function saveStore(cfg: Config, store: SlotStore): void {
  const file = storeFile(cfg);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The leases some checkout still holds. A lease with a pending setup is kept
// whole even when its registered paths are gone: the barrier, not the paths'
// absence, decides when its slot and environment may be freed.
function surviving(store: SlotStore): SlotStore {
  const leases = store.leases.flatMap((lease) => {
    if (lease.pendingSetup.length > 0) {
      return [lease];
    }
    const checkouts = lease.checkouts.filter((dir) => fs.existsSync(dir));
    if (checkouts.length === 0) {
      return [];
    }
    return [{ ...lease, checkouts }];
  });
  return { ...store, leases };
}

export { readStore, saveStore, storeFile, surviving };
