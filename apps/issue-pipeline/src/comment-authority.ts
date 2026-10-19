// Current comment content and editor provenance are read together. GitHub field
// semantics still require operator verification before activation.
import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";

const COMMENT_QUERY = `query($id:ID!) { node(id:$id) { ... on IssueComment {
  databaseId body createdAt updatedAt lastEditedAt author { login } editor { login }
} } }`;
const CURRENT_COMMENT = z.object({
  data: z.object({
    node: z.object({
      databaseId: z.number(),
      body: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      lastEditedAt: z.iso.datetime().nullable(),
      author: z.object({ login: z.string() }),
      editor: z.object({ login: z.string() }).nullable(),
    }),
  }),
});

function commentQuery(cfg: Config, nodeId: string): unknown {
  try {
    return ghJson(cfg, "merge", [
      "api",
      "graphql",
      "-f",
      `query=${COMMENT_QUERY}`,
      "-f",
      `id=${nodeId}`,
    ]);
  } catch (error) {
    throw new OpsError(
      "comment editor provenance query failed; stop for reconciliation",
      { cause: error },
    );
  }
}

// All merge-authored comments are checked, including edits removing markers.
// Body, author and editor must come from the same GraphQL read.
function currentComment(
  cfg: Config,
  item: IssueComment,
): z.infer<typeof CURRENT_COMMENT>["data"]["node"] | null {
  if (item.user?.login.toLowerCase() !== cfg.mergeAccount.toLowerCase()) {
    return null;
  }
  if (item.node_id === undefined) {
    throw new OpsError(
      `comment ${item.id} lacks editor provenance; stop for reconciliation`,
    );
  }
  const current = CURRENT_COMMENT.safeParse(commentQuery(cfg, item.node_id));
  if (!current.success || current.data.data.node.databaseId !== item.id) {
    throw new OpsError(
      `comment ${item.id} has unreadable editor provenance; stop for reconciliation`,
    );
  }
  const { node } = current.data.data;
  assertCommentAuthority(cfg, {
    ...item,
    body: node.body,
    user: node.author,
    lastEditedAt: node.lastEditedAt,
    editor: node.editor,
  });
  return node;
}

function assertCommentAuthority(cfg: Config, item: IssueComment): void {
  const merge = cfg.mergeAccount.toLowerCase();
  if (
    item.user?.login.toLowerCase() !== merge ||
    item.lastEditedAt === undefined ||
    item.editor === undefined ||
    (item.lastEditedAt !== null &&
      item.editor?.login.toLowerCase() !== merge) ||
    (item.lastEditedAt === null && item.editor !== null)
  ) {
    throw new OpsError(
      `comment ${item.id} has untrusted author/editor provenance; stop for reconciliation`,
    );
  }
}

export { assertCommentAuthority, currentComment };
