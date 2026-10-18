// The pipeline's comments on GitHub and the hidden marks they carry.
//
// One GitHub account does everything: opens PRs, posts every agent's review,
// and merges. It may also be a human's own account. So the pipeline never
// tells its comments apart by author. Every comment it posts is signed with
// the agent role that wrote it and carries a hidden PIPELINE_MARK; a comment
// counts as the pipeline's only when it has the mark AND the account wrote it.

import { z } from "zod";
import type { Config } from "./config.ts";
import { gh, ghLines } from "./github.ts";

const STATE_MARK = "<!-- agent-pipeline:state";
// The mark of an issue's n-th usage comment (src/job/usage-log.ts): the
// first is `usage`, the next `usage-2`, and so on.
const USAGE_MARK =
  /<!-- issue-pipeline:(?<issue>\d+):usage(?:-(?<n>[2-9]|[1-9]\d+))? -->/u;
const PIPELINE_MARK = /<!-- agent-pipeline:comment role=(?<role>[\w.:-]+) -->/u;
const PARENT_MARK =
  /<!-- agent-pipeline:parent (?<parent>\d+) depth (?<depth>\d+) -->/u;
const AFTER_MARK = /<!-- agent-pipeline:after (?<after>[\d,]+) -->/u;
const CLAIM_MARK =
  /<!-- agent-pipeline:claim lane=(?<lane>\S+) sweep=(?<sweep>\S+) -->/u;
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

function listComments(cfg: Config, number: number): IssueComment[] {
  const lines = ghLines(cfg, [
    "api",
    "--paginate",
    `repos/${cfg.repo}/issues/${number}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ]);
  return lines.map(commentOf);
}

// Posts `body` exactly as given: no signature, no mark.
function rawComment(cfg: Config, number: number, body: string): void {
  gh(cfg, [
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
  const lines = ghLines(cfg, [
    "api",
    "--paginate",
    `repos/${cfg.repo}/issues/comments?${query}`,
    "--jq",
    ".[] | @json",
  ]);
  return lines.map(commentOf);
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
//   **🤖 issue-pipeline · reviewer (scope)**
//   <sub>agent issue-pipeline-reader · model claude-sonnet-5-5 · run i7-review-scope-12</sub>
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
      item.user?.login === cfg.account && (item.body ?? "").includes(mark),
  );
  if (mine === undefined) {
    const posted = gh(cfg, [
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

// The issue's Gherkin comment (`author-maintains-gherkin`): signed by the
// author, keyed `gherkin`, and edited in place on every revision, so GitHub
// keeps its history. Its mark records the revision and the trusted-inputs
// revision it was written from.
const GHERKIN_KEY = "gherkin";
const GHERKIN_MARK =
  /<!-- issue-pipeline:gherkin rev=(?<rev>[1-9]\d*) inputs=(?<inputs>[0-9a-f]{64}) -->/u;
const GHERKIN_BLOCK = /```gherkin\n(?<gherkin>[\s\S]*?)\n```/u;

interface GherkinText {
  gherkin: string;
  assumptions: readonly string[];
  wikiPages: readonly string[];
}

interface GherkinComment extends GherkinText {
  id: number;
  rev: number;
  inputs: string;
}

function bulletSection(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return ["", `### ${heading}`, "", ...items.map((item) => `- ${item}`)];
}

function bullets(body: string, heading: string): string[] {
  const start = body.indexOf(`### ${heading}\n`);
  if (start < 0) {
    return [];
  }
  const rest = body.slice(start).split("\n").slice(1);
  const items: string[] = [];
  for (const line of rest) {
    if (line.startsWith("- ")) {
      items.push(line.slice(2));
    } else if (line !== "") {
      break;
    }
  }
  return items;
}

// The Gherkin comment's body, before the signature and the key's mark.
function gherkinBody(
  text: GherkinText,
  revision: { rev: number; inputs: string },
): string {
  return [
    "## Behaviour",
    "",
    "```gherkin",
    text.gherkin.trim(),
    "```",
    ...bulletSection("Assumptions", text.assumptions),
    ...bulletSection("Wiki pages", text.wikiPages),
    "",
    `<sub>Revision ${revision.rev}. The pipeline keeps this up to date from the issue and the comments of allowed users; reply on the issue to change it.</sub>`,
    `<!-- issue-pipeline:gherkin rev=${revision.rev} inputs=${revision.inputs} -->`,
  ].join("\n");
}

// The issue's Gherkin comment, or null when it has none. Only a comment the
// pipeline's account wrote, signed by the author, with the key's mark and the
// Gherkin mark, counts: anyone can paste the marks.
function gherkinCommentOf(
  cfg: Config,
  number: number,
  comments: readonly IssueComment[],
): GherkinComment | null {
  const mark = keyMark(number, GHERKIN_KEY);
  const found = comments.find(
    (item) =>
      pipelineRole(cfg, item) === "author" && (item.body ?? "").includes(mark),
  );
  const body = found?.body ?? "";
  const { rev, inputs } = GHERKIN_MARK.exec(body)?.groups ?? {};
  const { gherkin } = GHERKIN_BLOCK.exec(body)?.groups ?? {};
  if (
    found === undefined ||
    rev === undefined ||
    inputs === undefined ||
    gherkin === undefined
  ) {
    return null;
  }
  return {
    id: found.id,
    rev: Number(rev),
    inputs,
    gherkin,
    assumptions: bullets(body, "Assumptions"),
    wikiPages: bullets(body, "Wiki pages"),
  };
}

function pipelineRole(cfg: Config, item: IssueComment): string | null {
  if (item.user?.login !== cfg.account) {
    return null;
  }
  const body = item.body ?? "";
  if (body.includes(STATE_MARK)) {
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

export type { Author, GherkinComment, GherkinText, IssueComment };
export {
  AFTER_MARK,
  AUTHOR,
  CLAIM_MARK,
  COMMENT,
  comment,
  commentByKey,
  editComment,
  GHERKIN_KEY,
  gherkinBody,
  gherkinCommentOf,
  keyMark,
  listComments,
  listRepoComments,
  PARENT_MARK,
  PIPELINE_MARK,
  pipelineRole,
  rawComment,
  roleSlug,
  STATE_MARK,
  signature,
  signed,
  USAGE_MARK,
  usageMark,
};
