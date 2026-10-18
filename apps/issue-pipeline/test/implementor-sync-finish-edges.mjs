// @ts-check
// The edges of the implementor's start sync from finish-sync and the abort
// states, and the `sync` entry's check of whether the head moved (#419; the
// wiki's Pipeline-Roles-Implementor, "Start sync" and "Sync"), in the shape
// of implementor-sync-edge-fixtures.mjs, which joins them.
import { FINISHED } from "./implementor-sync-test-kit.mjs";

/** @import { SyncEdge } from "./implementor-sync-edge-fixtures.mjs" */

const RELEASED = { kind: "released" };
const STOPPED_CONFLICT = { kind: "stopped", code: "conflict" };
const SAVED_CHECKS = { kind: "saved", stage: "checks" };

/** @type {SyncEdge[]} */
const FINISH_EDGES = [
  {
    at: "finish-sync",
    result: "implement",
    reply: FINISHED,
    data: { conflictFixes: 1, syncs: 1 },
    next: "implement-work?",
    effect: "check:implement-work?",
    changes: { headSha: "eeeeeee", syncs: 1, syncedHead: "eeeeeee" },
  },
  {
    at: "finish-sync",
    result: "fix",
    reply: FINISHED,
    data: { conflictFixes: 1, syncs: 1 },
    next: "fix-work?",
    effect: "check:fix-work?",
    changes: { headSha: "eeeeeee", syncs: 1 },
  },
  {
    at: "finish-sync",
    result: "sync",
    reply: FINISHED,
    data: { conflictFixes: 1, testsOnly: false, passedSha: null },
    next: "sync-moved?",
    effect: "check:sync-moved?",
    changes: { headSha: "eeeeeee", testsOnly: false, passedSha: null },
  },
  {
    at: "finish-sync",
    result: "rejected",
    data: { conflictFixes: 1 },
    next: "rejected",
    effect: RELEASED,
  },
  {
    at: "finish-sync",
    result: "rejected",
    data: { conflictFixes: 2 },
    next: "rejected",
    effect: STOPPED_CONFLICT,
  },
  {
    at: "abort-cannot-fix",
    result: "aborted",
    data: { conflictFixes: 1, reply: null },
    next: "cannot-fix",
    effect: RELEASED,
  },
  {
    at: "abort-conflicts",
    result: "aborted",
    data: { conflictFixes: 2 },
    next: "conflicts",
    effect: STOPPED_CONFLICT,
  },
  {
    at: "abort-out-of-room",
    result: "aborted",
    data: { conflictFixes: 1 },
    next: "resolver-out-of-room",
    effect: { kind: "stopped", code: "too-large" },
  },
  {
    at: "abort-failed",
    result: "aborted",
    data: { conflictFixes: 1 },
    next: "resolver-failed",
    effect: { kind: "stopped", code: "error" },
  },
  {
    at: "sync-moved?",
    result: "moved",
    data: { syncs: 0 },
    next: "synced",
    effect: SAVED_CHECKS,
    changes: { syncs: 1 },
  },
  {
    at: "sync-moved?",
    result: "moved",
    data: { syncs: 3 },
    next: "too-many-syncs",
    effect: { kind: "stopped", code: "sync-limit" },
  },
  {
    at: "sync-moved?",
    result: "same",
    data: { syncs: 1 },
    next: "synced",
    effect: SAVED_CHECKS,
    changes: { syncs: 1 },
  },
];

export { FINISH_EDGES };
