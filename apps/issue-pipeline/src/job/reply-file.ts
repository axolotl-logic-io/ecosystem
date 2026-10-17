// A session's reply file (SessionEffect.replyFile): a file of the job's code
// checkout that a reply may point at instead of retyping it. When the reply
// sets the effect's `flag` to true, the reply is read with the file's text at
// the checkout's head in its `field`. With no such file at the head, the
// reply stays as the session gave it, for the role to judge. The spec writer
// uses it for its committed spec draft (spec-practices-digest, 2026-10-17).

import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { SessionEffect } from "../roles/machine.ts";

type ReplyFile = NonNullable<SessionEffect["replyFile"]>;

const RECORD = z.record(z.string(), z.unknown());

// The text of `file` at the head of the checkout `repo`, or null when the
// head has no such file.
function fileAtHead(repo: string, file: string): string | null {
  const shown = spawnSync("git", ["-C", repo, "show", `HEAD:${file}`], {
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    return null;
  }
  return shown.stdout;
}

function identity(reply: unknown): unknown {
  return reply;
}

// What reads a session's reply in checkout `repo` with `replyFile` filled
// in; with none, the reply as it is.
function replyFiller(
  repo: string,
  replyFile: ReplyFile | undefined,
): (reply: unknown) => unknown {
  if (replyFile === undefined) {
    return identity;
  }
  const { path, field, flag } = replyFile;
  return (reply: unknown): unknown => {
    const parsed = RECORD.safeParse(reply);
    if (!parsed.success) {
      return reply;
    }
    const fields = new Map(Object.entries(parsed.data));
    if (fields.get(flag) !== true) {
      return reply;
    }
    const text = fileAtHead(repo, path);
    if (text === null) {
      return reply;
    }
    fields.set(field, text);
    return Object.fromEntries(fields);
  };
}

export { replyFiller };
