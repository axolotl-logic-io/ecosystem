// What the implementor's start sync and `sync` entry (#419) carry in a run's
// data, and how locate reads it back from the issue's saved state: today's
// sync stage's top-level `syncs` and `passedSha`, its limits from the
// config, and the working fields of one rebase (the conflict it stopped on,
// the resolver's reading and its continuations, and whether the sync moved
// the head), with the head the last sync that moved it pushed. Pure.

import type { State } from "../../state.ts";
import type { FixOutput } from "../../workflow/stages/checks-reply.ts";
import { maxConflictFixes } from "../../workflow/stages/conflict-resolver.ts";
import type { StackedOn } from "../../workflow/stages/stacked.ts";
import type { SweepConfig } from "../../workflow/stages/types.ts";

// A rebase stopped on conflicts: the files, the base it stopped on, and what
// the issue is stacked on for that rebase, which the finish checks against
// and saves once the resolution is pushed.
interface SyncConflict {
  files: readonly string[];
  baseSha: string | null;
  stackedOn: StackedOn | null;
}

interface SyncFields {
  // The `sync` entry's rebases that changed the head, bounded by maxSyncs.
  syncs: number;
  // The head that passed every check before the merger sent it to sync.
  passedSha: string | null;
  // The config's limits on conflict resolutions and the sync entry's rebases.
  maxConflictFixes: number;
  maxSyncs: number;
  // The rebase's conflict while the resolver works on it, or null.
  conflict: SyncConflict | null;
  // The resolver's last reply, as fixOf reads it, or null.
  resolution: FixOutput | null;
  // The resolver's continuations in this run, apart from the implementer's.
  resolverContinuations: number;
  // Whether the sync changed the head.
  syncMoved: boolean;
  // Why finish-sync rejected the resolution, or null.
  rejection: string | null;
  // The head the last start sync that moved the branch pushed, undefined
  // before one. A checkpoint, so the run saves the pushed head as soon as
  // the sync ends, and a job held or killed after it leaves the issue at
  // the head on GitHub.
  syncedHead: string | undefined;
}

function countOr(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return value;
  }
  return fallback;
}

function textOr(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

// The saved sync fields, a `syncs` checkpoint winning over today's field.
function syncFieldsOf(saved: State, cfg: SweepConfig): SyncFields {
  const { syncs, passedSha } = saved;
  const { syncs: checkpoint, syncedHead } = saved.checkpoints ?? {};
  let passed: string | null = null;
  if (typeof passedSha === "string") {
    passed = passedSha;
  }
  return {
    syncs: countOr(checkpoint, countOr(syncs, 0)),
    passedSha: passed,
    maxConflictFixes: maxConflictFixes({ cfg }),
    maxSyncs: cfg.maxSyncs,
    conflict: null,
    resolution: null,
    resolverContinuations: 0,
    syncMoved: false,
    rejection: null,
    syncedHead: textOr(syncedHead),
  };
}

export type { SyncConflict, SyncFields };
export { syncFieldsOf };
