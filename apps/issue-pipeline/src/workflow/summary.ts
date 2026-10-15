// The merge summary's Acceptance line.

import type { RepoConfig, WorkItem } from "./types.ts";

type BaseConfig = Pick<RepoConfig, "baseBranch">;
type AcceptedItem = Pick<WorkItem, "st" | "rebasedOnly">;

function rebasedNote(cfg: BaseConfig, item: AcceptedItem): string {
  if (item.rebasedOnly === true) {
    return `passed before a clean rebase onto ${cfg.baseBranch}`;
  }
  return "";
}

// The verifier's reason from the saved state, so a merge in a later sweep keeps
// it, and whether that verdict was given before a clean rebase that only re-ran
// the tests. "" when there is neither.
function acceptanceSummary(cfg: BaseConfig, item: AcceptedItem): string {
  const reason = item.st.acceptReason ?? "";
  const rebased = rebasedNote(cfg, item);
  if (reason !== "" && rebased !== "") {
    return `${reason} (${rebased})`;
  }
  return reason || rebased;
}

export { acceptanceSummary };
