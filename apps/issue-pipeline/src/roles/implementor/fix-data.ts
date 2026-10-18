// What the implementor's `fix` entry (#418) carries in its run's data, and
// how locate reads it back from the issue's saved state: the review's
// hand-off (the reviewed head and patch id, the finding ids, the resolved
// history, the security rounds and the stack), the round's working fields
// (the fixer's reply, the re-review diff and each lens's reply), and the
// findings, parsed at this boundary. Pure.

import { z } from "zod";
import type { State } from "../../state.ts";
import type { Lens } from "../../workflow/lenses.ts";
import { isStrings } from "../../workflow/stages/reply-guards.ts";
import type { FixReply } from "../../workflow/stages/review-replies.ts";
import type { Finding, IssueState } from "../../workflow/types.ts";

// A stop update-findings found: a reintroduced finding or a bad reply.
interface FixStop {
  reason: string;
  detail: string;
}

interface FixFields {
  // The config's limit on fix rounds, which the open findings' stop names.
  maxFixRounds: number;
  // Today's fix round count, kept equal to fixRounds for the lanes' stages.
  round: number;
  reviewedSha: string | null;
  reviewedPatchId: string | null;
  nextFindingId: number;
  resolvedHistory: string[];
  // Kept as saved until a round resolves every finding, which clears it.
  testsOnly: boolean | undefined;
  // Whether a wiki-only change closed the issue's PR.
  prClosed: boolean;
  securityRounds: number;
  stackedOn: IssueState["stackedOn"];
  // The fixer's last reply, as fixReplyOf reads it, or null.
  fixReply: FixReply | null;
  // The re-review diff and its patch id, from prepare-review.
  diffPath: string | null;
  patchId: string | null;
  // Each lens's re-reviewer reply in this round, as the session gave it.
  rereviews: Partial<Record<Lens, unknown>>;
  fixStop: FixStop | null;
}

const FINDING = z.looseObject({
  id: z.string(),
  file: z.string(),
  line: z.number(),
  title: z.string(),
  evidence: z.string(),
  suggestion: z.string(),
  lenses: z.array(z.string()),
  category: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  disputed: z.boolean(),
  dispute: z.string().optional(),
});

function findingOf(value: unknown): Finding[] {
  const parsed = FINDING.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const { dispute, ...finding } = parsed.data;
  if (dispute === undefined) {
    return [finding];
  }
  return [{ ...finding, dispute }];
}

// The findings the fix entry works on; a malformed one is left out.
function findingsOf(
  findings: readonly unknown[] | null | undefined,
): Finding[] {
  return (findings ?? []).flatMap(findingOf);
}

function shaOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function numberOf(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  return 0;
}

// The saved state's fix fields, with the round count locate worked out and
// the config's limit on rounds.
function fixFieldsOf(
  saved: State,
  round: number,
  maxFixRounds: number,
): FixFields {
  const { reviewedSha, reviewedPatchId, nextFindingId } = saved;
  const { resolvedHistory, testsOnly, prClosed, securityRounds } = saved;
  let history: string[] = [];
  if (isStrings(resolvedHistory)) {
    history = [...resolvedHistory];
  }
  let tests: boolean | undefined;
  if (typeof testsOnly === "boolean") {
    tests = testsOnly;
  }
  return {
    maxFixRounds,
    round,
    reviewedSha: shaOf(reviewedSha),
    reviewedPatchId: shaOf(reviewedPatchId),
    nextFindingId: numberOf(nextFindingId),
    resolvedHistory: history,
    testsOnly: tests,
    prClosed: prClosed === true,
    securityRounds: numberOf(securityRounds),
    stackedOn: saved.stackedOn ?? null,
    fixReply: null,
    diffPath: null,
    patchId: null,
    rereviews: {},
    fixStop: null,
  };
}

export type { FixFields, FixStop };
export { findingsOf, fixFieldsOf };
