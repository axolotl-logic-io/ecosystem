// Display conversion for installed-version state; only explicitly validated
// landing-authored v1 data may pass the existing claim migration rules.
import { z } from "zod";
import type { Stage } from "./stages.ts";
import type { IssueState } from "./state.ts";
import { clippedLog, FLOWS, LEASE, newIssueState } from "./state.ts";

// The installed version's (version 1) fields the migration reads; it drops
// every other field.
const LEGACY_STATE = z.looseObject({
  stage: z.string().optional().catch(undefined),
  stoppedStage: z.string().nullish().catch(null),
  stopCode: z.string().nullish().catch(null),
  lease: LEASE.nullish().catch(null),
  pr: z.number().int().positive().nullish().catch(null),
  headSha: z.string().nullish().catch(null),
  flows: FLOWS.nullish().catch(null),
  log: z.array(z.unknown()).nullish().catch(null),
});

// Claim alone may migrate an explicit, identifiable installed-version state.
// Unknown versions/empty objects and v2 receipts cannot become a fresh v1 state.
const CLAIM_LEGACY_STATE = LEGACY_STATE.extend({
  version: z.literal(1),
  number: z.number().int().positive(),
  stage: z.enum([
    "triage",
    "spec",
    "implement",
    "review",
    "checks",
    "accept",
    "merge",
    "publish",
    "fix",
    "stopped",
    "done",
  ]),
  stoppedStage: LEGACY_STATE.shape.stoppedStage.removeCatch(),
  stopCode: LEGACY_STATE.shape.stopCode.removeCatch(),
  lease: LEGACY_STATE.shape.lease.removeCatch(),
  pr: LEGACY_STATE.shape.pr.removeCatch(),
  headSha: LEGACY_STATE.shape.headSha.removeCatch(),
  flows: LEGACY_STATE.shape.flows.removeCatch(),
  codeMerged: z.never().optional(),
  merged: z.never().optional(),
  hardened: z.never().optional(),
  integration: z.never().optional(),
  security: z.never().optional(),
  gherkin: z.never().optional(),
});

// Legacy stages before any code work, which go to the author alone.
const LEGACY_AUTHOR_STAGES: ReadonlySet<string> = new Set(["triage", "spec"]);

// Where a legacy stage resumes after the author writes the Gherkin: null for
// the stages before code work; review for `publish`, the legacy stage of an
// issue whose code landed while its wiki waited for publication; implement
// for every other stage, so the job verifies the branch afresh.
function legacyResumeStage(
  stage: string | undefined,
): Extract<Stage, "review" | "implement"> | null {
  if (stage === undefined || LEGACY_AUTHOR_STAGES.has(stage)) {
    return null;
  }
  if (stage === "publish") {
    return "review";
  }
  return "implement";
}

// A version 1 state read as version 2. Every legacy issue goes to the author
// first, since no Gherkin exists yet; it keeps its PR, head, lease and flows.
function migrateLegacyState(raw: unknown, number: number): IssueState {
  const legacy = LEGACY_STATE.safeParse(raw).data ?? {};
  const base = newIssueState(number, "author");
  const kept: IssueState = {
    ...base,
    lease: legacy.lease ?? null,
    pr: legacy.pr ?? null,
    headSha: legacy.headSha ?? null,
    flows: legacy.flows ?? null,
    log: clippedLog(
      (legacy.log ?? []).filter((entry) => typeof entry === "string"),
    ),
  };
  const { stage } = legacy;
  if (stage === "done") {
    return { ...kept, stage: "done" };
  }
  if (stage === "stopped") {
    return {
      ...kept,
      stage: "stopped",
      stoppedStage: "author",
      stopCode: legacy.stopCode ?? null,
      resumeStage: legacyResumeStage(legacy.stoppedStage ?? undefined),
    };
  }
  return { ...kept, resumeStage: legacyResumeStage(stage) };
}

export { CLAIM_LEGACY_STATE, LEGACY_STATE, migrateLegacyState };
