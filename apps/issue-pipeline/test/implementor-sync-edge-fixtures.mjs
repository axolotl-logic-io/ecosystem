// @ts-check
// Every edge of the implementor's shared start, its start sync and its `sync`
// entry (#419; the wiki's Pipeline-Roles-Implementor, "Start sync" and
// "Sync"), as a state, a result, the reply and data it is taken with, the
// next state, its effect (a check's or session's name, or the end's kind,
// code and stage) and the data fields it changes. States and results are
// plain strings, so a missing one fails as a missing edge.
import { FINISH_EDGES } from "./implementor-sync-finish-edges.mjs";
import {
  CONFLICT,
  FIXED,
  HEAD,
  MOVED_PREREQ,
  NEXT_CONFLICT,
  REBASED,
  REBASED_STACKED,
  STACKED_ON,
  UNCHANGED,
} from "./implementor-sync-test-kit.mjs";

/** @import { ImplData } from "../src/roles/implementor/locate.ts" */

/**
 * @typedef {object} SyncEdge
 * @property {string} at
 * @property {string} result
 * @property {unknown} [reply]
 * @property {Partial<ImplData>} [data]
 * @property {string} next
 * @property {string | Readonly<Record<string, string>>} effect
 * @property {Partial<ImplData>} [changes]
 */

const SAVED_CHECKS = { kind: "saved", stage: "checks" };
// The spec's tests, a commit before the branch's head.
const SPEC_TESTS = "0123456";
const ABORT = "check:abort";
const RESOLVER = "session:conflicts";

/** @type {SyncEdge[]} */
const START_EDGES = [
  {
    at: "start",
    result: "implement",
    next: "sync-work?",
    effect: "check:sync-work?",
  },
  {
    at: "start",
    result: "fix",
    next: "sync-work?",
    effect: "check:sync-work?",
  },
  {
    at: "start",
    result: "sync",
    next: "sync-work?",
    effect: "check:sync-work?",
  },
  { at: "sync-work?", result: "work", next: "rebase", effect: "check:rebase" },
  {
    at: "sync-work?",
    result: "work",
    reply: { headSha: HEAD, specAtHead: true },
    data: { headSha: null, specTestsSha: SPEC_TESTS },
    next: "rebase",
    effect: "check:rebase",
    changes: { headSha: HEAD, specTestsSha: HEAD },
  },
  {
    at: "sync-work?",
    result: "work",
    reply: { headSha: HEAD, specAtHead: false },
    data: { headSha: null, specTestsSha: SPEC_TESTS },
    next: "rebase",
    effect: "check:rebase",
    changes: { headSha: HEAD, specTestsSha: SPEC_TESTS },
  },
  {
    at: "sync-work?",
    result: "implement",
    reply: UNCHANGED,
    data: { syncs: 1 },
    next: "implement-work?",
    effect: "check:implement-work?",
    changes: { headSha: HEAD, syncs: 1, syncedHead: undefined },
  },
  {
    at: "sync-work?",
    result: "fix",
    reply: UNCHANGED,
    data: { syncs: 1 },
    next: "fix-work?",
    effect: "check:fix-work?",
    changes: { headSha: HEAD, syncs: 1 },
  },
  {
    at: "sync-work?",
    result: "sync",
    reply: UNCHANGED,
    data: { passedSha: HEAD, syncs: 1 },
    next: "synced",
    effect: SAVED_CHECKS,
    changes: { testsOnly: true, passedSha: null, syncs: 1 },
  },
  {
    at: "rebase",
    result: "implement",
    reply: REBASED_STACKED,
    data: { stackedOn: STACKED_ON, syncs: 1 },
    next: "implement-work?",
    effect: "check:implement-work?",
    changes: {
      headSha: "ccccccc",
      stackedOn: MOVED_PREREQ,
      syncs: 1,
      syncedHead: "ccccccc",
    },
  },
  {
    at: "rebase",
    result: "implement",
    reply: REBASED,
    data: { headSha: HEAD, specTestsSha: HEAD },
    next: "implement-work?",
    effect: "check:implement-work?",
    changes: { specTestsSha: "ccccccc" },
  },
  {
    at: "rebase",
    result: "implement",
    reply: REBASED,
    data: { headSha: HEAD, specTestsSha: SPEC_TESTS },
    next: "implement-work?",
    effect: "check:implement-work?",
    changes: { specTestsSha: SPEC_TESTS },
  },
  {
    at: "rebase",
    result: "fix",
    reply: REBASED,
    data: { syncs: 1 },
    next: "fix-work?",
    effect: "check:fix-work?",
    changes: { headSha: "ccccccc", syncs: 1 },
  },
  {
    at: "rebase",
    result: "sync",
    reply: REBASED,
    data: { passedSha: HEAD },
    next: "sync-moved?",
    effect: "check:sync-moved?",
    changes: { headSha: "ccccccc", testsOnly: true, passedSha: null },
  },
  {
    at: "rebase",
    result: "sync",
    reply: REBASED,
    data: { passedSha: "bbbbbbb", stackedOn: STACKED_ON },
    next: "sync-moved?",
    effect: "check:sync-moved?",
    changes: { testsOnly: false, passedSha: null, stackedOn: null },
  },
  {
    at: "rebase",
    result: "conflict",
    reply: CONFLICT,
    data: { conflictFixes: 0, passedSha: HEAD, testsOnly: true },
    next: "resolver",
    effect: RESOLVER,
    changes: { conflictFixes: 1, testsOnly: false, passedSha: null },
  },
  {
    at: "rebase",
    result: "conflict",
    reply: CONFLICT,
    data: { conflictFixes: 2 },
    next: "abort-conflicts",
    effect: ABORT,
    changes: { conflictFixes: 2 },
  },
];

/** @type {SyncEdge[]} */
const RESOLVER_EDGES = [
  {
    at: "resolver",
    result: "replied",
    reply: FIXED,
    data: { conflictFixes: 1 },
    next: "resolver-reply",
    effect: "check:resolver-reply",
  },
  {
    at: "resolver",
    result: "failed",
    data: { conflictFixes: 1 },
    next: "abort-failed",
    effect: ABORT,
  },
  {
    at: "resolver-reply",
    result: "fixed",
    data: { conflictFixes: 1 },
    next: "continue",
    effect: "check:continue",
  },
  {
    at: "resolver-reply",
    result: "cannot-fix",
    data: { conflictFixes: 1 },
    next: "abort-cannot-fix",
    effect: ABORT,
  },
  {
    at: "resolver-reply",
    result: "handoff",
    data: { conflictFixes: 1, continuations: 0 },
    next: "resolver",
    effect: RESOLVER,
    changes: { conflictFixes: 1, continuations: 0 },
  },
  {
    at: "resolver-reply",
    result: "bad",
    data: { conflictFixes: 1 },
    next: "abort-failed",
    effect: ABORT,
  },
  {
    at: "continue",
    result: "clean",
    data: { conflictFixes: 1 },
    next: "finish-sync",
    effect: "check:finish-sync",
  },
  {
    at: "continue",
    result: "conflict",
    reply: NEXT_CONFLICT,
    data: { conflictFixes: 1 },
    next: "resolver",
    effect: RESOLVER,
    changes: { conflictFixes: 2 },
  },
  {
    at: "continue",
    result: "conflict",
    reply: NEXT_CONFLICT,
    data: { conflictFixes: 2 },
    next: "abort-conflicts",
    effect: ABORT,
  },
];

const SYNC_EDGES = [...START_EDGES, ...RESOLVER_EDGES, ...FINISH_EDGES];

export { SYNC_EDGES };
