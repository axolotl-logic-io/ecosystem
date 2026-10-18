// The implementor's start sync and its `sync` entry (#419; the wiki's
// Pipeline-Roles-Implementor, "Start sync", "Sync" and "Stacked branches";
// `sync-at-edges`). Every entry passes through the start sync before its
// first state: a branch that lacks its target's head (the base, or a
// stacked prerequisite's head while it is open, as src/stack.ts decides) is
// rebased with sync-base, which pushes a clean rebase itself. A rebase that
// stops on conflicts runs the conflict resolver, bounded by
// maxConflictFixes, for each commit that stops; the role continues the
// rebase and finish-sync pushes the resolution. The `sync` entry then saves
// at checks, re-running only the tests for a clean rebase of a passed head,
// and counts each rebase that moved the head toward maxSyncs. A start sync
// in any other entry never touches `syncs`. Pure.

import { z } from "zod";
import { fixOf } from "../../workflow/stages/checks-reply.ts";
import type { StackedOn } from "../../workflow/stages/stacked.ts";
import { stackedOnOf } from "../../workflow/stages/stacked.ts";
import type { Edge, Guard } from "../machine.ts";
import type { ImplData, ImplState } from "./locate.ts";
import { resolverSession } from "./resolver-task.ts";
import type { ImplSpec, ImplStates } from "./states.ts";
import { check } from "./states.ts";
import type { SyncEnd } from "./sync-ends.ts";
import { SYNC_END_STATES } from "./sync-ends.ts";

type SyncState =
  | "sync-work?"
  | "rebase"
  | "resolver"
  | "resolver-reply"
  | "continue"
  | "finish-sync"
  | "abort-cannot-fix"
  | "abort-conflicts"
  | "abort-out-of-room"
  | "abort-failed"
  | "sync-moved?"
  | SyncEnd;

type ImplEdge = Edge<ImplState, ImplData>;

const CONFLICT_FIXES: Guard<ImplState, ImplData> = {
  field: "conflictFixes",
  limit: "maxConflictFixes",
  over: "abort-conflicts",
};

const RESOLVER_CONTINUATIONS: Guard<ImplState, ImplData> = {
  field: "resolverContinuations",
  limit: "maxContinuations",
  over: "abort-out-of-room",
};

const SYNCS: Guard<ImplState, ImplData> = {
  field: "syncs",
  limit: "maxSyncs",
  over: "too-many-syncs",
};

const FLOWS = z.object({ code: z.boolean(), wiki: z.boolean() });
const HEAD = z.looseObject({ headSha: z.string(), flows: FLOWS.optional() });
const DUE = z.looseObject({ headSha: z.string(), specAtHead: z.boolean() });
const FILES = z.looseObject({ files: z.array(z.string()) });
const BASE = z.looseObject({ baseSha: z.string().nullable() });
const REASON = z.looseObject({ reason: z.string() });

function recordOf(reply: unknown): Readonly<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).catch({}).parse(reply);
}

// What the issue is stacked on after a reply: the reply's, when it names one.
function stackedAfter(data: ImplData, reply: unknown): StackedOn | null {
  const stackedOn = stackedOnOf(recordOf(reply));
  if (stackedOn === undefined) {
    return data.stackedOn ?? null;
  }
  return stackedOn;
}

// The spec's tests after a sync from `before` to `headSha` that moved the
// head: a spec head that was the branch's head (the rebase is due, below)
// moves with it, so the base's changes never count as the implementer's.
function specAfter(
  data: ImplData,
  before: string | null,
  headSha: string,
): string | undefined {
  if (before !== null && data.specTestsSha === before) {
    return headSha;
  }
  return data.specTestsSha;
}

// The sync is done: the head before it, if it had passed every check and the
// sync didn't change it or rebased it cleanly, re-runs only the tests; the
// reply's head, flows and stack are saved. A sync that `rebased` and moved
// the head carries the spec's tests with it, and keeps the pushed head in
// the syncedHead checkpoint, which saves it at once.
function syncedWith(
  data: ImplData,
  reply: unknown,
  rebased: boolean,
): ImplData {
  const parsed = HEAD.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { headSha, flows = data.flows } = parsed.data;
  const before = data.headSha ?? null;
  const syncMoved = rebased && headSha !== before;
  let { specTestsSha, syncedHead } = data;
  if (syncMoved) {
    specTestsSha = specAfter(data, before, headSha);
    syncedHead = headSha;
  }
  return {
    ...data,
    testsOnly: data.passedSha !== null && data.passedSha === before,
    passedSha: null,
    headSha,
    flows,
    stackedOn: stackedAfter(data, reply),
    syncMoved,
    specTestsSha,
    syncedHead,
    conflict: null,
  };
}

// A branch that already had its target's head.
function unchanged(data: ImplData, reply: unknown): ImplData {
  return syncedWith(data, reply, false);
}

// A rebase that finished, cleanly or once resolved.
function synced(data: ImplData, reply: unknown): ImplData {
  return syncedWith(data, reply, true);
}

// The rebase is due: the checkout's head before it, which is also the
// spec's tests when it has no code change since them.
function due(data: ImplData, reply: unknown): ImplData {
  const parsed = DUE.safeParse(reply);
  if (!parsed.success) {
    return data;
  }
  const { headSha, specAtHead } = parsed.data;
  if (specAtHead) {
    return { ...data, headSha, specTestsSha: headSha };
  }
  return { ...data, headSha };
}

// A rebase stopped on conflicts: a resolution changes the code, so every
// check runs again, and a fresh resolver takes the files.
function conflicted(data: ImplData, reply: unknown): ImplData {
  const files = FILES.safeParse(reply).data?.files ?? [];
  const baseSha = BASE.safeParse(reply).data?.baseSha ?? null;
  return {
    ...data,
    testsOnly: false,
    passedSha: null,
    conflict: { files, baseSha, stackedOn: stackedAfter(data, reply) },
    resolution: null,
    resolverContinuations: 0,
  };
}

// The next commit of the rebase stopped on conflicts in the reply's files.
function stoppedAgain(data: ImplData, reply: unknown): ImplData {
  const files = FILES.safeParse(reply).data?.files ?? [];
  const { conflict } = data;
  if (conflict === null) {
    return data;
  }
  const next = { ...conflict, files };
  return {
    ...data,
    conflict: next,
    resolution: null,
    resolverContinuations: 0,
  };
}

function rejectedWith(data: ImplData, reply: unknown): ImplData {
  return { ...data, rejection: REASON.safeParse(reply).data?.reason ?? null };
}

// The edges from a state whose reply ends the sync, to each entry's first
// state: `implement-work?`, `fix-work?`, or the `sync` entry's check of
// whether the head moved, or its end once nothing was to do (`done`).
function toEntries(
  done: ImplState,
  apply: (data: ImplData, reply: unknown) => ImplData,
): Record<"implement" | "fix" | "sync", ImplEdge> {
  return {
    implement: { to: "implement-work?", apply },
    fix: { to: "fix-work?", apply },
    sync: { to: done, apply },
  };
}

// The stack and the conflict the finish checks the rebase against.
function finishPayload(data: ImplData): Readonly<Record<string, unknown>> {
  const { conflict } = data;
  return {
    baseSha: conflict?.baseSha ?? null,
    stackedOn: conflict?.stackedOn ?? null,
  };
}

// The check that aborts the rebase, giving `reason`, before the end `to`.
function abort(reason: string, to: SyncEnd): ImplSpec {
  return check("abort", () => ({ reason }), { aborted: { to } });
}

const SYNC_STEPS: ImplStates<Exclude<SyncState, SyncEnd>> = {
  "sync-work?": check(
    "sync-work?",
    (data: ImplData) => ({
      entry: data.entry,
      stackedOn: data.stackedOn ?? null,
      specTestsSha: data.specTestsSha ?? null,
    }),
    { work: { to: "rebase", apply: due }, ...toEntries("synced", unchanged) },
  ),
  rebase: check(
    "rebase",
    (data: ImplData) => ({
      entry: data.entry,
      stackedOn: data.stackedOn ?? null,
    }),
    {
      ...toEntries("sync-moved?", synced),
      conflict: { to: "resolver", apply: conflicted, count: CONFLICT_FIXES },
    },
  ),
  resolver: {
    kind: "session",
    effect: resolverSession,
    on: {
      replied: {
        to: "resolver-reply",
        apply: (data: ImplData, reply: unknown): ImplData => ({
          ...data,
          resolution: fixOf(reply),
        }),
      },
      failed: { to: "abort-failed" },
    },
  },
  "resolver-reply": check(
    "resolver-reply",
    (data: ImplData) => ({ reading: data.resolution }),
    {
      fixed: { to: "continue" },
      "cannot-fix": { to: "abort-cannot-fix" },
      handoff: { to: "resolver", count: RESOLVER_CONTINUATIONS },
      bad: { to: "abort-failed" },
    },
  ),
  continue: check("continue", () => ({}), {
    clean: { to: "finish-sync" },
    conflict: { to: "resolver", apply: stoppedAgain, count: CONFLICT_FIXES },
  }),
  "finish-sync": check(
    "finish-sync",
    (data: ImplData) => ({ entry: data.entry, ...finishPayload(data) }),
    {
      ...toEntries("sync-moved?", synced),
      rejected: { to: "rejected", apply: rejectedWith },
    },
  ),
  "abort-cannot-fix": abort(
    "the conflict resolver could not resolve the rebase",
    "cannot-fix",
  ),
  "abort-conflicts": abort("the conflict resolutions ran out", "conflicts"),
  "abort-out-of-room": abort(
    "the conflict resolver ran out of room",
    "resolver-out-of-room",
  ),
  "abort-failed": abort("the conflict resolver failed", "resolver-failed"),
  "sync-moved?": check(
    "sync-moved?",
    (data: ImplData) => ({ changed: data.syncMoved }),
    { moved: { to: "synced", count: SYNCS }, same: { to: "synced" } },
  ),
};

const SYNC_STATES: ImplStates<SyncState> = {
  ...SYNC_STEPS,
  ...SYNC_END_STATES,
};

export { SYNC_STATES };
