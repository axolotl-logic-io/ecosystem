// The pipeline's comments on GitHub and the hidden marks they carry.
//
// Development owns commits, pushes and PR lifecycle. Review/merge owns all
// comments. Role signatures describe model work, not authentication: current
// authorship and editor provenance establish operational authority.

import { z } from "zod";
import { assertCommentAuthority, currentComment } from "./comment-authority.ts";
import { isStateBody, PIPELINE_MARK, USAGE_MARK } from "./comment-marks.ts";
import type { Config } from "./config.ts";
import { gh, ghLines } from "./github.ts";

const UNSAFE_ROLE_CHARACTERS = /[^\w.:-]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
// GitHub refuses comments longer than 65536 characters.
const MAX_COMMENT_LENGTH = 65_000;
const DEFAULT_ROLE = "pipeline";

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

// Who wrote a comment: the agent role, and the agent, model and run when a
// model wrote it.
interface Author {
  role?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  run?: string | undefined;
}

// An Author as a request carries it: the workflow sends null for a field it
// has no value for, which parses as undefined.
const AUTHOR_FIELD = z
  .string()
  .nullish()
  .transform((text) => text ?? undefined);
const AUTHOR = z.looseObject({
  agent: AUTHOR_FIELD,
  model: AUTHOR_FIELD,
  role: AUTHOR_FIELD,
  run: AUTHOR_FIELD,
});

// A comment from a line of gh's `--jq '.[] | @json'`.
function commentOf(line: unknown): IssueComment {
  if (typeof line === "string") {
    return COMMENT.parse(JSON.parse(line));
  }
  return COMMENT.parse(line);
}

function verifiedComment(cfg: Config, item: IssueComment): IssueComment {
  const node = currentComment(cfg, item);
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
  const lines = ghLines(cfg, "merge", [
    "api",
    "--paginate",
    `repos/${cfg.repo}/issues/${number}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ]);
  return lines.map(commentOf).map((item) => verifiedComment(cfg, item));
}

// Posts `body` exactly as given: no signature, no mark.
function rawComment(cfg: Config, number: number, body: string): void {
  gh(cfg, "merge", [
    "api",
    "-X",
    "POST",
    `repos/${cfg.repo}/issues/${number}/comments`,
    "-f",
    `body=${body}`,
    "--silent",
  ]);
}

// Every comment on the repo's issues and PRs, or only those changed at or
// after `since` (an ISO time), in one paged listing.
function listRepoComments(cfg: Config, since: string | null): IssueComment[] {
  let query = "per_page=100";
  if (since !== null) {
    query = `${query}&since=${since}`;
  }
  const lines = ghLines(cfg, "merge", [
    "api",
    "--paginate",
    `repos/${cfg.repo}/issues/comments?${query}`,
    "--jq",
    ".[] | @json",
  ]);
  return lines.map(commentOf).map((item) => verifiedComment(cfg, item));
}

// The mark of issue `issue`'s n-th usage comment.
function usageMark(issue: number, n: number): string {
  let kind = "usage";
  if (n > 1) {
    kind = `usage-${n}`;
  }
  return `<!-- issue-pipeline:${issue}:${kind} -->`;
}

// `text`, or `fallback` when it is missing or empty.
function textOr(text: string | null | undefined, fallback: string): string {
  if (text === undefined || text === null || text === "") {
    return fallback;
  }
  return text;
}

function roleSlug(role: string | null | undefined): string {
  const slug = textOr(role, DEFAULT_ROLE)
    .toLowerCase()
    .replace(UNSAFE_ROLE_CHARACTERS, "-")
    .replace(EDGE_DASHES, "");
  return textOr(slug, DEFAULT_ROLE);
}

function metaLine(by: Author | undefined): string {
  const agent = textOr(by?.agent, "");
  const parts: string[] = [];
  if (agent === "") {
    parts.push("deterministic step, no model");
  } else {
    parts.push(`agent \`${agent}\``);
  }
  for (const [name, value] of [
    ["model", by?.model],
    ["run", by?.run],
  ]) {
    if (textOr(value, "") !== "") {
      parts.push(`${name} \`${value}\``);
    }
  }
  return parts.join(" · ");
}

// Header naming the agent that wrote the text, e.g.
//   **🤖 issue-pipeline · reviewer**
//   <sub>agent `issue-pipeline-reviewer` · model `claude-opus-5-5` · run `i7-review-12`</sub>
function signature(by: Author | undefined): string {
  const role = textOr(by?.role, DEFAULT_ROLE);
  return `**🤖 issue-pipeline · ${role}**\n<sub>${metaLine(by)}</sub>\n<!-- agent-pipeline:comment role=${roleSlug(role)} -->`;
}

function signed(by: Author | undefined, body: string): string {
  return `${signature(by)}\n\n${body}`.slice(0, MAX_COMMENT_LENGTH);
}

function comment(
  cfg: Config,
  number: number,
  by: Author | undefined,
  body: string,
): void {
  rawComment(cfg, number, signed(by, body));
}

// Replaces comment `id`'s body; with `allowFail`, a failed edit is ignored.
function editComment(
  cfg: Config,
  id: number,
  body: string,
  options: { allowFail?: boolean } = {},
): void {
  gh(
    cfg,
    "merge",
    [
      "api",
      "-X",
      "PATCH",
      `repos/${cfg.repo}/issues/comments/${id}`,
      "-f",
      `body=${body}`,
      "--silent",
    ],
    options,
  );
}

// Writes `body`, signed by `by`, as issue `number`'s one comment keyed
// `key`: it edits the pipeline account's comment that carries the key's
// hidden marker, and posts a new one only when there is none, so writing
// it again posts nothing twice.
function commentByKey(
  cfg: Config,
  number: number,
  by: Author | undefined,
  keyed: { body: string; key: string },
): number {
  const mark = keyMark(number, keyed.key);
  const text = `${signed(by, keyed.body)}\n${mark}`;
  const mine = listComments(cfg, number).find(
    (item) =>
      item.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() &&
      (item.body ?? "").includes(mark),
  );
  if (mine === undefined) {
    const posted = gh(cfg, "merge", [
      "api",
      "-X",
      "POST",
      `repos/${cfg.repo}/issues/${number}/comments`,
      "-f",
      `body=${text}`,
      "--jq",
      ".id",
    ]);
    return Number(posted.stdout.trim());
  }
  editComment(cfg, mine.id, text);
  return mine.id;
}

// The hidden mark of a keyed comment, which `commentByKey` finds it by.
function keyMark(number: number, key: string): string {
  return `<!-- issue-pipeline:${number}:${key} -->`;
}

function pipelineRole(
  cfg: Pick<Config, "mergeAccount">,
  item: IssueComment,
): string | null {
  if (item.user?.login.toLowerCase() !== cfg.mergeAccount.toLowerCase()) {
    return null;
  }
  assertCommentAuthority(cfg, item);
  const body = item.body ?? "";
  if (isStateBody(body)) {
    return "state";
  }
  const { role } = PIPELINE_MARK.exec(body)?.groups ?? {};
  if (role !== undefined) {
    return role;
  }
  if (USAGE_MARK.test(body)) {
    return "usage";
  }
  return null;
}

export type { Author, IssueComment };
export {
  AUTHOR,
  COMMENT,
  comment,
  commentByKey,
  editComment,
  keyMark,
  listComments,
  listRepoComments,
  pipelineRole,
  rawComment,
  roleSlug,
  signature,
  signed,
  usageMark,
};
