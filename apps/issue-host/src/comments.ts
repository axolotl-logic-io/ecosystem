// The pipeline's comments on GitHub and the hidden marks they carry.
//
// Historical role signatures describe model work, not authentication.
// Authorship and editor provenance establish operational authority.

import { z } from "zod";
import {
  assertCommentAuthority,
  type currentComment,
  currentComments,
} from "./comment-authority.ts";
import type { Config } from "./config.ts";
import { ghLines } from "./github.ts";

const PIPELINE_MARK = /<!-- agent-pipeline:comment role=(?<role>[\w.:-]+) -->/u;

// An issue comment as GitHub's REST API gives it.
const COMMENT = z.looseObject({
  body: z.string().nullish(),
  created_at: z.string(),
  id: z.number(),
  node_id: z.string().optional(),
  lastEditedAt: z.string().nullable().optional(),
  editor: z.object({ login: z.string() }).nullable().optional(),
  updated_at: z.string().nullish(),
  user: z.looseObject({ login: z.string() }).nullish(),
});

type IssueComment = z.infer<typeof COMMENT>;

// A comment from a line of gh's `--jq '.[] | @json'`.
function commentOf(line: unknown): IssueComment {
  if (typeof line === "string") {
    return COMMENT.parse(JSON.parse(line));
  }
  return COMMENT.parse(line);
}

// `items`, each landing-authored one replaced by its current verified read.
function verifiedComments(
  cfg: Config,
  items: readonly IssueComment[],
  relevant?: (body: string) => boolean,
): IssueComment[] {
  const nodes = currentComments(cfg, items, relevant);
  return items.map((item, at) => withNode(item, nodes[at] ?? null));
}

function withNode(
  item: IssueComment,
  node: ReturnType<typeof currentComment>,
): IssueComment {
  if (node === null) {
    return item;
  }
  return {
    ...item,
    body: node.body,
    user: node.author,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    lastEditedAt: node.lastEditedAt,
    editor: node.editor,
  };
}

function listComments(cfg: Config, number: number): IssueComment[] {
  const lines = ghLines(cfg, "landing", [
    "api",
    "--paginate",
    `repos/${cfg.repo}/issues/${number}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ]);
  return verifiedComments(cfg, lines.map(commentOf));
}

function pipelineCommentAgent(
  cfg: Pick<Config, "landingAccount">,
  item: IssueComment,
): string | null {
  if (item.user?.login.toLowerCase() !== cfg.landingAccount.toLowerCase()) {
    return null;
  }
  assertCommentAuthority(cfg, item);
  const body = item.body ?? "";
  const { role } = PIPELINE_MARK.exec(body)?.groups ?? {};
  if (role !== undefined) {
    return role;
  }
  return null;
}

export type { IssueComment };
export { listComments, pipelineCommentAgent };
