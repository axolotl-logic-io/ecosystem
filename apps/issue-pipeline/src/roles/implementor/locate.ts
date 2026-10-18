// Where an implementor run starts, and what it carries (`every-role-resumes`
// in the wiki's Pipeline-Roles-Shared page; Pipeline-Roles-Implementor,
// "Locate"). Every run starts at the shared `start`, which names its entry;
// the entry's own `…-work?` check skips work already done, since the saved
// state alone can't tell a branch with work from one without. It reads back
// the checkpoints (the counts that bound the entries' loops) and the
// hand-off fields. A state saved by today's implement stage keeps its
// continuation count, read through stages/continuation.ts. Pure.

import { z } from "zod";
import type { State } from "../../state.ts";
import type { Budgets } from "../../workflow/budget.ts";
import type { Flows } from "../../workflow/flows.ts";
import type { Lens } from "../../workflow/lenses.ts";
import type { Signature } from "../../workflow/signing.ts";
import { continuationsOf } from "../../workflow/stages/continuation.ts";
import { isStrings } from "../../workflow/stages/reply-guards.ts";
import type { ModelRole, SweepConfig } from "../../workflow/stages/types.ts";
import type { ItemPaths } from "../../workflow/types.ts";
import type { MachineState } from "../machine.ts";
import type { RoleContext } from "../walk.ts";
import type { FixFields } from "./fix-data.ts";
import { fixFieldsOf } from "./fix-data.ts";
import type { ImplReading } from "./reply.ts";
import type { SyncFields } from "./sync-data.ts";
import { syncFieldsOf } from "./sync-data.ts";

// The machine's states: the shared start, the start sync's (#419), the
// `implement` entry's states (the wiki's Lifecycle table), then its ends.
type ImplState =
  | "start"
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
  // The `sync` entry's state and the start sync's ends.
  | "sync-moved?"
  | "synced"
  | "too-many-syncs"
  | "rejected"
  | "cannot-fix"
  | "conflicts"
  | "resolver-out-of-room"
  | "resolver-failed"
  | "implement-work?"
  | "setup"
  | "implementer"
  | "implementer-reply"
  | "flows"
  | "implemented"
  | "wiki-only"
  | "blocked"
  | "changed-nothing"
  | "bad-reply"
  | "out-of-room"
  // The `fix` entry's states (#418): the fixer, the push, the re-review
  // diff, a check and a session for each lens in ALL_LENSES order, the
  // findings' update, and its ends.
  | "fix-work?"
  | "fixer"
  | "fixer-reply"
  | "fix-flows"
  | "prepare-rereview"
  | `rereview-${Lens}?`
  | `rereview-${Lens}`
  | "update-findings"
  | "fixed"
  | "fix-reopen"
  | "fix-no-code"
  | "findings-open"
  | "acceptance-disputed"
  | "reintroduced"
  | "rereview-bad"
  | "fixer-bad-reply"
  | "fixer-out-of-room";

// The entries a run can take; a later part adds `checks`.
type ImplEntry = "implement" | "fix" | "sync";

// What the session's task is built from.
interface ImplSettings {
  cfg: SweepConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  paths: ItemPaths;
}

// What the spec writer handed over, and what the run hands to the
// reviewer.
interface ImplHandoff {
  spec: string | undefined;
  specFile: string | null | undefined;
  plan: string | undefined;
  specTestsSha: string | undefined;
  wikiOnly: boolean | undefined;
  noTestsReason: string | null | undefined;
  pr: number | null | undefined;
  // The test and stub files the spec documents that the branch lacked at a
  // restart (the claim's checkedSpecFiles), for the implementer to write.
  unwrittenFiles: readonly string[];
  headSha: string | null | undefined;
  flows: Flows | undefined;
  implemented: boolean | undefined;
  // As saved; the fix entry reads them through findingsOf (fix-data.ts).
  findings: unknown[];
  verifiedSha: string | null;
}

// The counts the entries bound their loops with.
interface ImplCounts {
  continuations: number;
  // The fixer's continuations, counted apart from the implementer's.
  fixContinuations: number;
  fixRounds: number;
  conflictFixes: number;
  ciFixRounds: number;
}

interface ImplData extends ImplHandoff, ImplCounts, FixFields, SyncFields {
  issue: number;
  entry: ImplEntry;
  // Who signs the run's comments.
  by: Signature;
  settings: ImplSettings;
  // The config's limit on continuations.
  maxContinuations: number;
  // The last session's reading, or null before one.
  reply: ImplReading | null;
}

// The role its comments are signed as, and the agent its sessions run as.
const IMPL_ROLE = "implementer";
const IMPL_AGENT = "issue-pipeline-writer";

// Today's implement stage's count: a number (the older form) or a count per
// writer stage.
const OLD_CONTINUATIONS = z.union([
  z.number(),
  z.record(z.string(), z.number()),
]);
const FLOWS = z.object({ code: z.boolean(), wiki: z.boolean() });

function textOr<T>(value: unknown, fallback: T): string | T {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function nullOr(value: unknown): null | undefined {
  if (value === null) {
    return null;
  }
  return undefined;
}

function countOr(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return value;
  }
  return fallback;
}

function booleanOr(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function prOf(value: unknown): number | null | undefined {
  if (typeof value === "number") {
    return value;
  }
  return nullOr(value);
}

// The continuations today's `stage` stage saved, 0 when it saved none.
function oldContinuations(saved: State, stage: "implement" | "fix"): number {
  const { continuations } = saved;
  const parsed = OLD_CONTINUATIONS.safeParse(continuations);
  if (!parsed.success) {
    return 0;
  }
  return continuationsOf({ continuations: parsed.data }, stage);
}

// The saved counts; the role's own checkpoint wins over the old field (today's
// sync stage saved `conflictFixes` at the top level), and a missing or
// malformed one reads as 0. Today's fix stage
// counts its rounds in `round` and the fixer's continuations apart, so
// either count is the higher of the checkpoint and today's.
function countsOf(saved: State): ImplCounts {
  const { continuations, fixContinuations, fixRounds } =
    saved.checkpoints ?? {};
  const { conflictFixes, ciFixRounds } = saved.checkpoints ?? {};
  const { round, conflictFixes: oldConflictFixes } = saved;
  return {
    continuations: countOr(continuations, oldContinuations(saved, "implement")),
    fixContinuations: Math.max(
      countOr(fixContinuations, 0),
      oldContinuations(saved, "fix"),
    ),
    fixRounds: Math.max(countOr(fixRounds, 0), countOr(round, 0)),
    conflictFixes: countOr(conflictFixes, countOr(oldConflictFixes, 0)),
    ciFixRounds: countOr(ciFixRounds, 0),
  };
}

// The saved hand-off fields; a malformed one reads as missing.
function handoffOf(saved: State): ImplHandoff {
  const { spec, specFile, plan, specTestsSha, wikiOnly, noTestsReason } = saved;
  const { pr, unwrittenFiles, headSha, flows, implemented } = saved;
  const { verifiedSha } = saved;
  let unwritten: readonly string[] = [];
  if (isStrings(unwrittenFiles)) {
    unwritten = unwrittenFiles;
  }
  return {
    spec: textOr(spec, undefined),
    specFile: textOr(specFile, nullOr(specFile)),
    plan: textOr(plan, undefined),
    specTestsSha: textOr(specTestsSha, undefined),
    wikiOnly: booleanOr(wikiOnly),
    noTestsReason: textOr(noTestsReason, nullOr(noTestsReason)),
    pr: prOf(pr),
    unwrittenFiles: unwritten,
    headSha: textOr(headSha, nullOr(headSha)),
    flows: FLOWS.safeParse(flows).data,
    implemented: booleanOr(implemented),
    findings: saved.findings ?? [],
    verifiedSha: textOr(verifiedSha, null),
  };
}

// The entry a state saved at `fix` or `sync` takes; any other, `implement`.
function entryOf(saved: State): ImplEntry {
  const { stage } = saved;
  if (stage === "fix" || stage === "sync") {
    return stage;
  }
  return "implement";
}

function locate(
  saved: State,
  context: RoleContext,
): MachineState<ImplState, ImplData> {
  const { issue, jobId, cfg, budgets, models, paths } = context;
  const by: Signature = {
    role: IMPL_ROLE,
    agent: IMPL_AGENT,
    model: models.implementer,
    run: jobId,
  };
  const counts = countsOf(saved);
  const data: ImplData = {
    ...handoffOf(saved),
    ...counts,
    ...fixFieldsOf(saved, counts.fixRounds, cfg.maxFixRounds),
    ...syncFieldsOf(saved, cfg),
    issue,
    entry: entryOf(saved),
    by,
    settings: { cfg, budgets, models, paths },
    maxContinuations: cfg.maxContinuations,
    reply: null,
  };
  return { at: "start", data };
}

export type { ImplData, ImplEntry, ImplSettings, ImplState };
export { IMPL_AGENT, IMPL_ROLE, locate };
