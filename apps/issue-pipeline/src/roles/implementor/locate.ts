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
import type { Signature } from "../../workflow/signing.ts";
import { continuationsOf } from "../../workflow/stages/continuation.ts";
import { isStrings } from "../../workflow/stages/reply-guards.ts";
import type { ModelRole, SweepConfig } from "../../workflow/stages/types.ts";
import type { ItemPaths } from "../../workflow/types.ts";
import type { MachineState } from "../machine.ts";
import type { RoleContext } from "../walk.ts";
import type { ImplReading } from "./reply.ts";

// The machine's states: the shared start, the `implement` entry's states
// (the wiki's Lifecycle table), then its ends.
type ImplState =
  | "start"
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
  | "out-of-room";

// The entries a run can take; later parts add `fix` and `checks`.
type ImplEntry = "implement";

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
  findings: unknown[];
  verifiedSha: string | null;
}

// The counts the entries bound their loops with.
interface ImplCounts {
  continuations: number;
  fixRounds: number;
  conflictFixes: number;
  ciFixRounds: number;
}

interface ImplData extends ImplHandoff, ImplCounts {
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

// The continuations today's implement stage saved, 0 when it saved none.
function oldContinuations(saved: State): number {
  const { continuations } = saved;
  const parsed = OLD_CONTINUATIONS.safeParse(continuations);
  if (!parsed.success) {
    return 0;
  }
  return continuationsOf({ continuations: parsed.data }, "implement");
}

// The saved counts; the role's own continuations checkpoint wins over the
// old field, and a missing or malformed one reads as 0.
function countsOf(saved: State): ImplCounts {
  const { continuations, fixRounds, conflictFixes, ciFixRounds } =
    saved.checkpoints ?? {};
  return {
    continuations: countOr(continuations, oldContinuations(saved)),
    fixRounds: countOr(fixRounds, 0),
    conflictFixes: countOr(conflictFixes, 0),
    ciFixRounds: countOr(ciFixRounds, 0),
  };
}

// The saved hand-off fields; a malformed one reads as missing.
function handoffOf(saved: State): ImplHandoff {
  const { spec, specFile, plan, specTestsSha, wikiOnly, noTestsReason } = saved;
  const { pr, unwrittenFiles, headSha, flows, implemented } = saved;
  const { findings, verifiedSha } = saved;
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
    findings: findings ?? [],
    verifiedSha: textOr(verifiedSha, null),
  };
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
  const data: ImplData = {
    ...handoffOf(saved),
    ...countsOf(saved),
    issue,
    entry: "implement",
    by,
    settings: { cfg, budgets, models, paths },
    maxContinuations: cfg.maxContinuations,
    reply: null,
  };
  return { at: "start", data };
}

export type { ImplData, ImplEntry, ImplSettings, ImplState };
export { IMPL_AGENT, IMPL_ROLE, locate };
