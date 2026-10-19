// The comments a request carries, which the ops CLI posts before its op, in
// order, so they land even when the op fails; and the post op, which does
// nothing more. Each comment is signed with the role that wrote it; a keyed
// one is written once and edited in place after (commentByKey).

import { z } from "zod";
import type { Author } from "../comments.ts";
import { AUTHOR, commentByKey, signed } from "../comments.ts";
import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import { OpsError } from "../ops-error.ts";

const QUEUED_COMMENT = z.looseObject({
  body: z.string(),
  by: AUTHOR.nullish(),
  key: z.string().nullish(),
  number: z.number().int().positive(),
});

const COMMENT_ID = /^\d+$/u;

type QueuedComment = z.infer<typeof QUEUED_COMMENT>;

// Posts `body` signed by `by` on issue or PR `number` and returns the new
// comment's id.
function postSigned(
  cfg: Config,
  number: number,
  by: Author | undefined,
  body: string,
): number {
  const posted = gh(cfg, "merge", [
    "api",
    "-X",
    "POST",
    `repos/${cfg.repo}/issues/${number}/comments`,
    "-f",
    `body=${signed(by, body)}`,
    "--jq",
    ".id",
  ]).stdout.trim();
  if (!COMMENT_ID.test(posted)) {
    throw new OpsError(`GitHub gave no id for the comment on #${number}`);
  }
  return Number(posted);
}

// Posts `comments` in order and returns their ids, in the same order.
function postComments(
  cfg: Config,
  comments: readonly QueuedComment[],
): number[] {
  return comments.map(({ body, by, key, number }) => {
    if (typeof key === "string") {
      return commentByKey(cfg, number, by ?? undefined, { body, key });
    }
    return postSigned(cfg, number, by ?? undefined, body);
  });
}

// Only posts the queued comments (the ops CLI does that before any op).
function post(): Record<string, never> {
  return {};
}

export { post, postComments, QUEUED_COMMENT };
