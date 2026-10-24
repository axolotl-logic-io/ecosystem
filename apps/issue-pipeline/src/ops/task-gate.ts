// Fresh reads every revision-bound task op makes (#184, #185;
// `fresh-reads`): ancestry in a checkout, and whether a binding's trusted
// inputs and policy are still today's.

import type { Config } from "../config.ts";
import { trustedInputsHash, writeIssueContext } from "../issue-context.ts";
import { run } from "../process.ts";
import { configPolicyDigest } from "../project-policy.ts";
import type { Binding } from "../task-result-records.ts";

// A binding of a revision: every task after Author and the first
// Implementation.
type RevisionBinding = Extract<Binding, { revision: unknown }>;

function isRevisionBinding(binding: Binding): binding is RevisionBinding {
  return "revision" in binding;
}

// Whether `ancestor` is reachable from `commit` in the checkout `wt`.
function contains(wt: string, commit: string, ancestor: string): boolean {
  const args = ["-C", wt, "merge-base", "--is-ancestor", ancestor, commit];
  return run("git", args, { allowFail: true }).code === 0;
}

// The binding's trusted inputs and policy are still today's: a task of a
// stale revision would bind its result to inputs nobody hardened.
function assertCurrentRevision(
  cfg: Config,
  number: number,
  binding: RevisionBinding,
  refuse: (reason: string) => never,
): void {
  if (binding.revision.policy !== configPolicyDigest(cfg)) {
    refuse("the binding's policy is not the current policy");
  }
  const context = writeIssueContext(cfg, number);
  if (
    binding.revision.inputs !==
    trustedInputsHash(cfg, context.issue, context.comments)
  ) {
    refuse("the binding's trusted inputs are not the current inputs");
  }
}

export type { RevisionBinding };
export { assertCurrentRevision, contains, isRevisionBinding };
