// Where a spec writer run starts, and what it carries (`every-role-resumes`
// in the wiki's Pipeline-Roles-Shared page). It reads back the checkpoints
// (the heads the spec stage began from, the sessions run and the
// continuations taken, so a restart keeps its limits and its resets'
// targets) and the hand-off fields. An
// issue whose spec is published with its tests committed goes straight to
// its PR, so a restart posts no second spec; every other start claims the
// issue and runs the session again, since the reply isn't kept across a
// crash. Pure.

import type { State } from "../../state.ts";
import type { Signature } from "../../workflow/signing.ts";
import { isStrings } from "../../workflow/stages/reply-guards.ts";
import type { ItemPaths } from "../../workflow/types.ts";
import type { MachineState } from "../machine.ts";
import type { RoleContext } from "../walk.ts";
import type { SpecInterface, SpecReading } from "./reply.ts";
import { interfacesOf } from "./reply.ts";
import type { SpecCommitted, SpecSettings } from "./task.ts";
import { SPEC_AGENT, SPEC_ROLE, wikiDirOf } from "./task.ts";

// The machine's states: the wiki's Lifecycle table, then its ends.
type SpecState =
  | "claim"
  | "checkout"
  | "session"
  | "check-reply"
  | "check-commits"
  | "confirm-no-work"
  | "retry"
  | "resume"
  | "reset"
  | "ask"
  | "split"
  | "stop-no-work"
  | "publish-spec"
  | "open-pr"
  | "close-old-pr"
  | "released"
  | "split-opened"
  | "asked"
  | "no-work"
  | "pr-opened"
  | "wiki-only"
  | "failed-twice"
  | "split-refused"
  | "out-of-room";

// The states a run can start at.
type SpecEntry = "claim" | "open-pr" | "close-old-pr";

// What the run hands to the next role: the spec (or where the whole of it
// is), the files it touches, its interfaces, the head with its tests
// committed, why it has no tests, if it has none, that this role wrote the
// tests, and the draft PR with its head, not yet implemented.
interface SpecHandoff {
  spec: string | undefined;
  specFile: string | null | undefined;
  files: string[] | undefined;
  interfaces: SpecInterface[] | undefined;
  specTestsSha: string | undefined;
  noTestsReason: string | null | undefined;
  specWritesTests: boolean | undefined;
  pr: number | null | undefined;
  headSha: string | null | undefined;
  implemented: boolean | undefined;
}

// A start head: the sha, null for a branch this stage created, or
// undefined before checkout saved it.
type StartSha = string | null | undefined;

interface SpecData extends SpecHandoff {
  issue: number;
  // 0 for an issue, 1 for a sub-issue.
  depth: number;
  plan: string | undefined;
  splitSuggested: string | null | undefined;
  // Who signs the run's comments.
  by: Signature;
  // What the session's task is built from.
  settings: SpecSettings & { paths: ItemPaths };
  // The sessions run on the issue, this one included, less continuations.
  attempts: number;
  // The continuations taken after a handoff, and the config's limit on them.
  continuations: number;
  maxContinuations: number;
  // What the stage committed since its start heads, once listed.
  committed: SpecCommitted | null;
  startSha: StartSha;
  startWikiSha: StartSha;
  // What the run read from the last session's reply, or null before one.
  reply: SpecReading | null;
  // The last failure's output, which a retry's task includes.
  checkOutput: string | null;
}

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

function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value !== "";
}

function countOf(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  return 0;
}

// The saved checkpoints; a missing or malformed one reads as missing.
function checkpointsOf(
  saved: State,
): Pick<SpecData, "attempts" | "continuations" | "startSha" | "startWikiSha"> {
  const { attempts, continuations, startSha, startWikiSha } =
    saved.checkpoints ?? {};
  return {
    attempts: countOf(attempts),
    continuations: countOf(continuations),
    startSha: textOr(startSha, nullOr(startSha)),
    startWikiSha: textOr(startWikiSha, nullOr(startWikiSha)),
  };
}

// The saved hand-off fields; a malformed one reads as missing.
function handoffOf(saved: State): SpecHandoff {
  const { spec, specFile, files, interfaces, specTestsSha, noTestsReason } =
    saved;
  const { specWritesTests, pr, headSha, implemented } = saved;
  let kept: string[] | undefined;
  if (isStrings(files)) {
    kept = files;
  }
  let prNumber: number | null | undefined = nullOr(pr);
  if (typeof pr === "number") {
    prNumber = pr;
  }
  let built: boolean | undefined;
  if (typeof implemented === "boolean") {
    built = implemented;
  }
  return {
    spec: textOr(spec, undefined),
    specFile: textOr(specFile, nullOr(specFile)),
    files: kept,
    interfaces: interfacesOf(interfaces),
    specTestsSha: textOr(specTestsSha, undefined),
    noTestsReason: textOr(noTestsReason, nullOr(noTestsReason)),
    specWritesTests,
    pr: prNumber,
    headSha: textOr(headSha, nullOr(headSha)),
    implemented: built,
  };
}

// Whether the change is wiki-only: it has no tests, and every file it
// touches is a wiki page (the commit check's rule, check.ts).
function wikiOnly(
  handoff: Pick<SpecHandoff, "files" | "noTestsReason">,
  paths: ItemPaths,
): boolean {
  const prefix = `${wikiDirOf(paths)}/`;
  return (
    typeof handoff.noTestsReason === "string" &&
    (handoff.files ?? []).every((file) => file.startsWith(prefix))
  );
}

// The state a run starts at: the PR's, once the spec is published with its
// tests committed, and otherwise the claim.
function startOf(handoff: SpecHandoff, paths: ItemPaths): SpecEntry {
  const published =
    filled(handoff.specTestsSha) &&
    (filled(handoff.spec) || filled(handoff.specFile));
  if (!published) {
    return "claim";
  }
  if (wikiOnly(handoff, paths)) {
    return "close-old-pr";
  }
  return "open-pr";
}

function locate(
  saved: State,
  context: RoleContext,
): MachineState<SpecState, SpecData> {
  const { issue, cfg, budgets, models, paths } = context;
  const { depth, plan, splitSuggested } = saved;
  const handoff = handoffOf(saved);
  const by: Signature = {
    role: SPEC_ROLE,
    agent: SPEC_AGENT,
    model: models.spec,
    run: null,
  };
  const data: SpecData = {
    ...handoff,
    ...checkpointsOf(saved),
    issue,
    depth: depth ?? 0,
    plan: textOr(plan, undefined),
    splitSuggested: textOr(splitSuggested, nullOr(splitSuggested)),
    by,
    settings: { cfg, budgets, models, paths },
    maxContinuations: cfg.maxContinuations,
    committed: null,
    reply: null,
    checkOutput: null,
  };
  return { at: startOf(handoff, paths), data };
}

export type { SpecData, SpecHandoff, SpecState };
export { locate, wikiOnly };
