// The usage op: appends one usage record line to the issue's usage comments
// (src/job/usage-comment.ts). It edits the account's highest-numbered usage
// comment in place, posts the next one when that one is full, and posts the
// first when there is none. A comment carrying the mark that another
// account wrote is ignored.

import { z } from "zod";
import type { IssueComment } from "../comments.ts";
import {
  editComment,
  listComments,
  rawComment,
  USAGE_MARK,
} from "../comments.ts";
import type { Config } from "../config.ts";
import { appendedBody, usageBody } from "../job/usage-comment.ts";
import { parseUsageLine, serializeUsage } from "../job/usage-log.ts";
import { OpsError, parseRequest } from "../process.ts";

const USAGE_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  line: z.string(),
});

// What the op did: the number of the usage comment that holds the line, and
// whether it was edited in place rather than posted.
interface UsageReply {
  usageComment: number;
  edited: boolean;
}

interface Marked {
  id: number;
  n: number;
  body: string;
}

// The account's usage comment on issue `number` with the highest n, if any.
function lastMarked(
  cfg: Config,
  number: number,
  comments: readonly IssueComment[],
): Marked | null {
  let last: Marked | null = null;
  for (const { id, body, user } of comments) {
    const { issue, n: nth = "1" } = USAGE_MARK.exec(body ?? "")?.groups ?? {};
    if (user?.login === cfg.account && issue === String(number)) {
      const n = Number(nth);
      if (last === null || n > last.n) {
        last = { id, n, body: body ?? "" };
      }
    }
  }
  return last;
}

// The line as the serializer writes it, or an OpsError when it holds no
// usage record or holds what would end the comment's hidden block.
function checkedLine(line: string): string {
  const record = parseUsageLine(line);
  if (record === undefined) {
    throw new OpsError("usage: the line is not a usage record");
  }
  try {
    return serializeUsage(record);
  } catch (error: unknown) {
    throw new OpsError("usage: the line may not end the hidden block", {
      cause: error,
    });
  }
}

function usage(cfg: Config, request: unknown): UsageReply {
  const { number, line } = parseRequest(USAGE_REQUEST, "usage", request);
  const checked = checkedLine(line);
  const last = lastMarked(cfg, number, listComments(cfg, number));
  if (last === null) {
    rawComment(cfg, number, usageBody(number, 1, [checked]));
    return { usageComment: 1, edited: false };
  }
  const body = appendedBody(last.body, checked);
  if (body === null) {
    const n = last.n + 1;
    rawComment(cfg, number, usageBody(number, n, [checked]));
    return { usageComment: n, edited: false };
  }
  editComment(cfg, last.id, body);
  return { usageComment: last.n, edited: true };
}

export { usage };
