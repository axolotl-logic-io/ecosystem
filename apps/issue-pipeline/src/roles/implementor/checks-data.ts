// What the implementor's `checks` entry carries (the wiki's
// Pipeline-Roles-Implementor, "Entry `checks`"): its states, the hand-off
// fields it reads back from a state saved at checks, today's checks stage's
// included, and what it carries between its states within a run. Pure.

import { z } from "zod";
import type { State } from "../../state.ts";
import type { FixOutput } from "../../workflow/stages/checks-reply.ts";
import type { SweepConfig } from "../../workflow/stages/types.ts";

// The `checks` entry's states, which run its effects, and its ends.
type ChecksStep =
  | "checks-work?"
  | "wiki-check"
  | "verify"
  | "ci-status"
  | "ci-fixer"
  | "ci-fixer-reply"
  | "fix-push"
  | "prepare-fix-review"
  | "check-fix-correctness"
  | "check-fix-scope"
  | "check-fix-review";

type ChecksEnd =
  | "checked"
  | "ci-pending"
  | "fix-limit"
  | "fix-out-of-room"
  | "checks-unrelated"
  | "bad-fix-reply"
  | "bad-review"
  | "verify-moved"
  | "ci-moved"
  | "no-ci";

type ChecksState = ChecksStep | ChecksEnd;

// The lenses that review a CI fix, one session each.
type FixLens = "correctness" | "scope";

// A check-fix reviewer's reply, as its session gave it.
interface FixReview {
  lens: FixLens;
  reply: unknown;
}

// The hand-off fields the entry reads and writes besides those it shares
// with the `fix` entry (fix-data.ts): `testsOnly`, whether only the tests
// run again (a clean rebase of a head that passed everything, which goes on
// to merge once they pass); `reviewedSha` and `reviewedPatchId`, what the
// PR's review or a check fix's last cleared; and `stackedOn`.
interface ChecksHandoff {
  // The head that passed local verification, and what passed.
  verifiedSha: string | null;
  verifySummary: string | undefined;
}

// What the entry carries between its states within a run.
interface ChecksRun {
  // The config's limit on CI-fix rounds.
  maxCiFixes: number;
  // The failing checks the CI fixer works on, or null before a failure.
  failure: string | null;
  // The CI fixer's last reply, or null before one or when it didn't read.
  fix: FixOutput | null;
  // The pushed fix's review diff and its patch id.
  diffPath: string | null;
  patchId: string | null;
  reviews: readonly FixReview[];
  // Whether the checks that passed were a tests-only rerun.
  rebasedOnly: boolean;
}

const TEXT = z.string();

function textOrNull(value: unknown): string | null {
  return TEXT.safeParse(value).data ?? null;
}

// The saved hand-off fields; a malformed one reads as missing.
function checksHandoffOf(saved: State): ChecksHandoff {
  const { verifiedSha, verifySummary } = saved;
  return {
    verifiedSha: textOrNull(verifiedSha),
    verifySummary: TEXT.safeParse(verifySummary).data,
  };
}

// The carry at the start of a run, under the config's CI-fix limit.
function checksRunOf(cfg: SweepConfig): ChecksRun {
  return {
    maxCiFixes: cfg.maxCiFixes,
    failure: null,
    fix: null,
    diffPath: null,
    patchId: null,
    reviews: [],
    rebasedOnly: false,
  };
}

export type {
  ChecksEnd,
  ChecksHandoff,
  ChecksRun,
  ChecksState,
  ChecksStep,
  FixLens,
  FixReview,
};
export { checksHandoffOf, checksRunOf };
