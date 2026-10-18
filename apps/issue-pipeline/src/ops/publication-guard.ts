// The gates between an authorized revision and what merge and publish (and,
// through finish-guard.ts, finish-wiki) may do to GitHub and the wiki, decided against a fresh
// current revision (src/revision.ts) and the issue's saved state rather
// than any claim in a request. Publishing and finishing also need the saved
// security review to have found nothing at exactly the merged result. Each
// gate is pure: an inconsistent request or GitHub answer throws, a revision
// that moved returns a refusal, and undefined lets the op go on.

import { z } from "zod";
import { OpsError } from "../process.ts";
import type { currentRevision } from "../revision.ts";
import { securityRefusal } from "../security-clearance.ts";
import type { IssueState, Revision } from "../state.ts";
import { approvalHolds, mergeAuthorization, sameRevision } from "../state.ts";

type CurrentRevision = ReturnType<typeof currentRevision>;

// A revision a request names: what hardening authorized (state.ts's Revision).
const REVISION_REQUEST = z.object({
  code: z.string().nullable(),
  wiki: z.string().nullable(),
  inputs: z.string().min(1),
});

interface MergeStale {
  merged: false;
  reason: "stale";
  current: Revision;
}

interface PublishRefusal {
  published: false;
  reason:
    | "unapproved"
    | "stale"
    | "not-merged"
    | "code-mismatch"
    | "no-receipt"
    | "security";
  detail: string;
}

// A merge goes on only while the code head, wiki head and trusted inputs are
// still the authorized `revision` (mergeAuthorization).
function mergeStale(
  revision: Revision,
  current: CurrentRevision,
): MergeStale | undefined {
  if (sameRevision(revision, current.revision)) {
    return undefined;
  }
  return { merged: false, reason: "stale", current: current.revision };
}

// The issue's PR as the current revision reports it, which must be the
// state's PR, merged with a merge commit that agrees with codeMerged.
function mergedPr(
  state: IssueState,
  current: CurrentRevision,
): { mergeCommit: string; headSha: string } | "open" {
  const { pr } = current;
  if (pr === null || pr.number !== state.pr) {
    throw new OpsError(
      `#${state.number}'s PR #${String(state.pr)} is missing from the current revision`,
    );
  }
  if (pr.state !== "MERGED") {
    return "open";
  }
  if (pr.mergeCommit === null || pr.mergeCommit === "") {
    throw new OpsError(`PR #${pr.number} is MERGED with no merge commit`);
  }
  const { codeMerged } = state;
  if (
    codeMerged !== null &&
    (codeMerged.pr !== pr.number || codeMerged.sha !== pr.mergeCommit)
  ) {
    throw new OpsError(
      `the state's codeMerged ${codeMerged.sha} of PR #${codeMerged.pr} is not PR #${pr.number}'s merge commit ${pr.mergeCommit}`,
    );
  }
  return { mergeCommit: pr.mergeCommit, headSha: pr.headSha };
}

function publishRefusal(
  reason: PublishRefusal["reason"],
  detail: string,
): PublishRefusal {
  return { published: false, reason, detail };
}

// Why the saved state is not the partial code-merge receipt of the merge
// that GitHub reports, for the authorized `revision`, or undefined. The
// receipt is the issue saved at stage merge with `merged` naming GitHub's
// merge commit and the authorized wiki and inputs, its PR the same, and its
// merge authorization (mergeAuthorization: the hardened head, or the head
// the Reviewer's own integration checked from it) permitting the exact head
// GitHub merged.
// Only the saved state counts: the request's state and the job's log are no
// proof.
function receiptRefusal(
  saved: IssueState | null,
  state: IssueState,
  revision: Revision,
  merged: { mergeCommit: string; headSha: string },
): PublishRefusal | undefined {
  if (saved === null || saved.stage !== "merge" || saved.merged === null) {
    return publishRefusal(
      "no-receipt",
      `#${state.number} has no saved code-merge receipt at stage merge`,
    );
  }
  const { merged: receipt } = saved;
  const authorized = mergeAuthorization(saved);
  const holds =
    saved.pr === state.pr &&
    receipt.code === merged.mergeCommit &&
    receipt.wiki === revision.wiki &&
    receipt.inputs === revision.inputs &&
    authorized !== null &&
    sameRevision(authorized, revision) &&
    revision.code === merged.headSha;
  if (holds) {
    return undefined;
  }
  return publishRefusal(
    "no-receipt",
    `the saved receipt (code ${String(receipt.code)}, wiki ${String(receipt.wiki)}) is not PR #${String(state.pr)}'s merge ${merged.mergeCommit} of the authorized head ${String(revision.code)}`,
  );
}

// Why the code side forbids publishing `revision`, or undefined. With a PR,
// GitHub must say it merged; a revision reviewed after the merge
// (codeMerged) names the merge commit, and one reviewed before it, in the
// job that merged it, names exactly the head GitHub merged and needs that
// job's saved receipt. Without a PR, a change that lives only in the wiki
// keeps the checkout at the reviewed code.
function codeRefusal(
  state: IssueState,
  saved: IssueState | null,
  revision: Revision,
  current: CurrentRevision,
): PublishRefusal | undefined {
  if (state.pr === null) {
    if (state.flows?.code === true) {
      return publishRefusal("not-merged", "the code flow has no PR to merge");
    }
    if (current.pr !== null) {
      return publishRefusal(
        "stale",
        `GitHub has PR #${current.pr.number} for a change the state says is wiki-only`,
      );
    }
    if (current.revision.code !== revision.code) {
      return publishRefusal(
        "stale",
        `the code checkout is at ${String(current.revision.code)}, not the approved ${String(revision.code)}`,
      );
    }
    return undefined;
  }
  const merged = mergedPr(state, current);
  if (merged === "open") {
    return publishRefusal("not-merged", `PR #${state.pr} has not merged`);
  }
  let expected = merged.headSha;
  if (state.codeMerged !== null) {
    expected = merged.mergeCommit;
  }
  if (revision.code !== expected) {
    return publishRefusal(
      "code-mismatch",
      `the approved code ${String(revision.code)} is not ${expected}, which PR #${state.pr} merged`,
    );
  }
  if (state.codeMerged === null) {
    return receiptRefusal(saved, state, revision, merged);
  }
  return undefined;
}

// Why the wiki of `revision` may not be published, or undefined. The wiki
// head itself is checked by the publish (wiki-publish.ts), since a retry
// after a publish sees the wiki no longer ahead. `saved` is the issue's
// saved state, read fresh.
function publishGate(
  state: IssueState,
  saved: IssueState | null,
  request: { expectedWiki: string | null; revision: Revision },
  current: CurrentRevision,
): PublishRefusal | undefined {
  const { expectedWiki, revision } = request;
  if (expectedWiki !== revision.wiki) {
    throw new OpsError(
      `publish expectedWiki ${String(expectedWiki)} is not the revision's wiki ${String(revision.wiki)}`,
    );
  }
  if (!approvalHolds(state, revision)) {
    return publishRefusal(
      "unapproved",
      "neither the Reviewer's hardening nor its own integration of it authorized this exact revision",
    );
  }
  if (current.revision.inputs !== revision.inputs) {
    return publishRefusal(
      "stale",
      `the trusted inputs changed since hardening (${current.revision.inputs})`,
    );
  }
  const refused = codeRefusal(state, saved, revision, current);
  if (refused !== undefined) {
    return refused;
  }
  const result = mergedResult(state, revision, current);
  const uncleared = securityRefusal(saved, result);
  if (uncleared !== undefined) {
    return publishRefusal("security", uncleared);
  }
  return undefined;
}

// The merged result a security review must have cleared before `revision`'s
// wiki is published: GitHub's merge commit of the issue's PR (null for a
// change that lives only in the wiki, with no PR), the wiki head and the
// trusted inputs. Only called once codeRefusal found the PR merged.
function mergedResult(
  state: IssueState,
  revision: Revision,
  current: CurrentRevision,
): Revision {
  let code: string | null = null;
  if (state.pr !== null) {
    const merged = mergedPr(state, current);
    if (merged === "open") {
      throw new OpsError(`PR #${state.pr} has not merged`);
    }
    code = merged.mergeCommit;
  }
  return { code, wiki: revision.wiki, inputs: revision.inputs };
}

export type { CurrentRevision, MergeStale, PublishRefusal };
export { mergedPr, mergeStale, publishGate, REVISION_REQUEST };
