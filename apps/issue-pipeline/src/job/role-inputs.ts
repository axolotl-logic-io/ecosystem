// The issue's inputs as a role sees them at its job's start: the issue and
// its comments from the claim's snapshot, the one its issue file was written
// from, or read afresh (rewriting the issue file) when the claim's reply
// carried none; their trusted-inputs revision; and the issue's Gherkin
// comment. Reading both from one snapshot keeps the revision a role records
// to exactly the inputs it was shown.

import { z } from "zod";
import type { IssueComment } from "../comments.ts";
import { COMMENT } from "../comments.ts";
import type { Config } from "../config.ts";
import { gherkinCommentOf } from "../gherkin-comment.ts";
import type { Issue } from "../issue-context.ts";
import {
  ISSUE,
  trustedInputsHash,
  writeIssueContext,
} from "../issue-context.ts";
import type { RoleInputs } from "./role-context.ts";

const SNAPSHOT = z.looseObject({ issue: ISSUE, comments: z.array(COMMENT) });

// The role's inputs for issue `issue`, from the claim's reply `claim`.
function inputsOf(cfg: Config, issue: number, claim: unknown): RoleInputs {
  const snapshot = SNAPSHOT.safeParse(claim);
  let read: { issue: Issue; comments: readonly IssueComment[] };
  if (snapshot.success) {
    read = snapshot.data;
  } else {
    read = writeIssueContext(cfg, issue);
  }
  const { comments } = read;
  return {
    issue: read.issue,
    comments,
    revision: trustedInputsHash(cfg, read.issue, comments),
    gherkin: gherkinCommentOf(cfg, issue, comments),
  };
}

export { inputsOf };
