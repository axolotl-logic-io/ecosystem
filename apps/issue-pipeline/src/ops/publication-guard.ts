// The gates between a reviewed revision and what merge, publish and
// finish-wiki may do to GitHub and the wiki, decided against a fresh
// current revision (src/revision.ts) rather than any saved claim. Each gate
// is pure: an inconsistent request or GitHub answer throws, a revision that
// moved returns a refusal, and undefined lets the op go on.

import { z } from "zod";
import { OpsError } from "../process.ts";
import type { currentRevision } from "../revision.ts";
import type { IssueState, Revision } from "../state.ts";
import { approvalHolds } from "../state.ts";

type CurrentRevision = ReturnType<typeof currentRevision>;

// A revision a request names: what the review approved (state.ts's Revision).
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
  reason: "unapproved" | "stale" | "not-merged" | "code-mismatch";
  detail: string;
}

interface FinishRefusal {
  finished: false;
  reason: "inputs-changed" | "wiki-unpublished" | "wiki-changed";
  detail: string;
}

function sameRevision(a: Revision, b: Revision): boolean {
  return a.code === b.code && a.wiki === b.wiki && a.inputs === b.inputs;
}

// A merge goes on only while the code head, wiki head and trusted inputs are
// still the approved `revision`.
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

// Why the code side forbids publishing `revision`, or undefined. With a PR,
// GitHub must say it merged; a revision reviewed after the merge
// (codeMerged) names the merge commit, and one reviewed before it, in the
// job that merged it, names exactly the head GitHub merged. Without a PR, a
// change that lives only in the wiki keeps the checkout at the reviewed code.
function codeRefusal(
  state: IssueState,
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
  return undefined;
}

// Why the wiki of `revision` may not be published, or undefined. The wiki
// head itself is checked by the publish (wiki-publish.ts), since a retry
// after a publish sees the wiki no longer ahead.
function publishGate(
  state: IssueState,
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
      "the last review did not approve this exact revision",
    );
  }
  if (current.revision.inputs !== revision.inputs) {
    return publishRefusal(
      "stale",
      `the trusted inputs changed since the approval (${current.revision.inputs})`,
    );
  }
  return codeRefusal(state, revision, current);
}

// The saved completion finish-wiki may act on: done, with the merged
// revision, its PR (if any) merged at merged.code, and the trusted inputs
// unchanged since. A state that isn't such a completion throws; new trusted
// input refuses, so the issue stays open for the author.
function finishGate(
  saved: IssueState,
  current: CurrentRevision,
): FinishRefusal | undefined {
  const { merged } = saved;
  if (saved.stage !== "done" || merged === null) {
    throw new OpsError(
      `finish-wiki needs #${saved.number}'s saved state done with a merged revision; it is ${saved.stage}`,
    );
  }
  if (saved.pr === null) {
    if (saved.flows?.code === true) {
      throw new OpsError(`#${saved.number} is done with a code flow but no PR`);
    }
  } else {
    const pr = mergedPr(saved, current);
    if (pr === "open" || pr.mergeCommit !== merged.code) {
      throw new OpsError(
        `#${saved.number} is saved merged at ${String(merged.code)}, which is not PR #${saved.pr}'s merge commit`,
      );
    }
  }
  if (current.revision.inputs !== merged.inputs) {
    return {
      finished: false,
      reason: "inputs-changed",
      detail: `the trusted inputs changed since the merge (${current.revision.inputs})`,
    };
  }
  return undefined;
}

export type { CurrentRevision, FinishRefusal, MergeStale, PublishRefusal };
export { finishGate, mergeStale, publishGate, REVISION_REQUEST };
