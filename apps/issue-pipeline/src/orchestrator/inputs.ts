// The trusted-inputs revisions the scheduler compares for one issue
// (`trusted-inputs-revision`), read from the issue and its comments as
// GitHub has them: the current revision, the one the issue's Gherkin
// comment records, and the one its author's questions were asked on.
// trustedInputsHash counts only the title, the body and the comments of
// allowed users who are still collaborators, never a visitor's comment or
// one the pipeline wrote, so only trusted human input moves the current
// revision. Only the landing identity's provenance-checked Gherkin comment
// counts.

import { AFTER_MARK } from "../comment-marks.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { gherkinCommentOf } from "../gherkin-comment.ts";
import type { Issue } from "../issue-context.ts";
import { trustedInputsHash } from "../issue-context.ts";
import type { IssueState } from "../state.ts";
import type { InputRevisions } from "./queue.ts";

// Issue `number`'s revisions, from its title and body, its comments and its
// saved state.
function inputRevisionsOf(
  cfg: Config,
  number: number,
  issue: Pick<Issue, "title" | "body" | "user">,
  read: { comments: readonly IssueComment[]; state: IssueState | null },
): InputRevisions {
  const { comments, state } = read;
  return {
    current: trustedInputsHash(cfg, issue, comments),
    gherkin: gherkinCommentOf(cfg, number, comments)?.inputs ?? null,
    asked: state?.asked?.inputs ?? null,
  };
}

// The issues the body's after mark names.
function afterMarkOf(body: string | null | undefined): number[] {
  const { after } = AFTER_MARK.exec(body ?? "")?.groups ?? {};
  return (after ?? "")
    .split(",")
    .filter((dep) => dep !== "")
    .map(Number);
}

export { afterMarkOf, inputRevisionsOf };
