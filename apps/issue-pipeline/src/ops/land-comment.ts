// Mutation comments name the exact candidate's hardening and Security, not
// the historical checked-integration exception or a later model pass.
import type { IssueState } from "../state.ts";

const SHORT_SHA_LENGTH = 12;

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA_LENGTH) ?? "none";
}

function landedText(
  state: IssueState,
  head: string,
  mergeCommit: string,
): string {
  return `Merged ${short(head)} as ${short(mergeCommit)}: the Reviewer's hardening passed on ${short(state.hardened?.code ?? null)}; checks and premerge Security cleared ${short(head)}. Exact-result deterministic checks follow before completion, without another model review.`;
}

export { landedText };
