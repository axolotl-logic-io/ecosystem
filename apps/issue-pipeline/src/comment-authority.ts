// Current comment content and editor provenance are read together. GitHub field
// semantics still require operator verification before activation.
import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";

const COMMENT_FIELDS =
  "databaseId body createdAt updatedAt lastEditedAt author { login } editor { login }";
const COMMENT_QUERY = `query($id:ID!) { node(id:$id) { ... on IssueComment {
  ${COMMENT_FIELDS}
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

function graphql(cfg: Config, fields: readonly string[]): unknown {
  try {
    return ghJson(cfg, "landing", [
      "api",
      "graphql",
      ...fields.flatMap((field) => ["-f", field]),
    ]);
  } catch (error) {
    throw new OpsError(
      "comment editor provenance query failed; stop for reconciliation",
      { cause: error },
    );
  }
}

type CurrentNode = z.infer<typeof CURRENT_COMMENT>["data"]["node"];

// A listing's landing-authored comments, verified in one read: an alias per
// comment, each answered as COMMENT_QUERY's node would be.
const BATCH = z.object({
  data: z.record(z.string(), CURRENT_COMMENT.shape.data.shape.node.nullable()),
});

function isLandingAuthored(cfg: Config, item: IssueComment): boolean {
  return item.user?.login.toLowerCase() === cfg.landingAccount.toLowerCase();
}

function nodeIdOf(item: IssueComment): string {
  if (item.node_id === undefined) {
    throw new OpsError(
      `comment ${item.id} lacks editor provenance; stop for reconciliation`,
    );
  }
  return item.node_id;
}

// `node`, the current read of `item`, once it proves the same comment with
// landing authorship and editor provenance.
function checkedNode(
  cfg: Config,
  item: IssueComment,
  node: CurrentNode | null | undefined,
): CurrentNode {
  if (node === null || node === undefined || node.databaseId !== item.id) {
    throw new OpsError(
      `comment ${item.id} has unreadable editor provenance; stop for reconciliation`,
    );
  }
  assertCommentAuthority(cfg, {
    ...item,
    body: node.body,
    user: node.author,
    lastEditedAt: node.lastEditedAt,
    editor: node.editor,
  });
  return node;
}

// All landing-authored comments are checked, including edits removing markers.
// Body, author and editor must come from the same GraphQL read.
function currentComment(cfg: Config, item: IssueComment): CurrentNode | null {
  if (!isLandingAuthored(cfg, item)) {
    return null;
  }
  const fields = [`query=${COMMENT_QUERY}`, `id=${nodeIdOf(item)}`];
  const current = CURRENT_COMMENT.safeParse(graphql(cfg, fields));
  return checkedNode(cfg, item, current.data?.data.node);
}

// currentComment for each of `items`, with every landing-authored one read in
// one GraphQL request when there are several, so a listing's cost doesn't
// grow with its history (#167).
function currentComments(
  cfg: Config,
  items: readonly IssueComment[],
): (CurrentNode | null)[] {
  const merged = items.filter((item) => isLandingAuthored(cfg, item));
  if (merged.length < 2) {
    return items.map((item) => currentComment(cfg, item));
  }
  const names = merged.map((_item, at) => `c${at}`);
  const params = names.map((name) => `$${name}:ID!`).join(",");
  const aliases = names.map((name) => `${name}: node(id:$${name}) { ...C }`);
  const fragment = `fragment C on IssueComment { ${COMMENT_FIELDS} }`;
  const query = `query=query(${params}) { ${aliases.join(" ")} } ${fragment}`;
  const ids = merged.map((item, at) => `${names[at]}=${nodeIdOf(item)}`);
  const batch = BATCH.safeParse(graphql(cfg, [query, ...ids]));
  const nodes = new Map(
    merged.map((item, at) => [
      item,
      checkedNode(cfg, item, batch.data?.data[`c${at}`]),
    ]),
  );
  return items.map((item) => nodes.get(item) ?? null);
}

function assertCommentAuthority(
  cfg: Pick<Config, "landingAccount">,
  item: IssueComment,
): void {
  const merge = cfg.landingAccount.toLowerCase();
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

export { assertCommentAuthority, currentComment, currentComments };
