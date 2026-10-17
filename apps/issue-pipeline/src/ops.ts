#!/usr/bin/env node
// Deterministic git and GitHub operations for the issue pipeline.
//
// The workflow script has no shell, so it runs this file through the
// `issue-pipeline-ops` external-cli agent. The request is one JSON object
// between BEGIN_OPS_REQUEST and END_OPS_REQUEST on stdin. The reply is one
// JSON line on stdout. Handled failures exit 0 with {"ok":false,...}; only
// crashes exit non-zero.
//
// No language model runs here. This file is the only code that reads the
// pipeline's token file.
//
// One GitHub account does everything: opens PRs, posts every agent's review,
// and merges. It may also be a human's own account. So the pipeline never
// tells its comments apart by author. Every comment it posts is signed with
// the agent role that wrote it and carries a hidden PIPELINE_MARK; a comment
// counts as the pipeline's only when it has the mark AND the account wrote it.

import fs from "node:fs";
import process from "node:process";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { AUTHOR, comment, commentByKey } from "./comments.ts";
import type { Config } from "./config.ts";
import { loadConfig, withCheckout } from "./config.ts";
import { ask } from "./ops/ask.ts";
import { ciStatus } from "./ops/ci-status.ts";
import { claim } from "./ops/claim.ts";
import { cleanup } from "./ops/cleanup.ts";
import { closeParent, finishWiki, post, release } from "./ops/finish.ts";
import { merge } from "./ops/merge.ts";
import { prOps } from "./ops/pr.ts";
import { publishOps } from "./ops/publish.ts";
import { saveSpec } from "./ops/save-spec.ts";
import { saveState } from "./ops/save-state.ts";
import { split } from "./ops/split.ts";
import { stop } from "./ops/stop.ts";
import { sweep } from "./ops/sweep.ts";
import { syncOps } from "./ops/sync.ts";
import { usage } from "./ops/usage.ts";
import { verify } from "./ops/verify.ts";
import { wikiCheck } from "./ops/wiki-check.ts";
import { ROOT } from "./pipeline-root.ts";
import { OpsError, parseRequest } from "./process.ts";

// An op reads its own fields from the whole request and returns its reply.
type Op = (cfg: Config, request: unknown) => object;

// The line printed for a request: the op's own reply follows ok, op and
// posted, or the error says why there is none.
interface OpsReply {
  ok: true;
  op: string;
  posted: number;
}

interface ErrorReply {
  ok: false;
  error: string;
}

const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  ...Object.entries(prOps),
  ...Object.entries(syncOps),
  ["sweep", sweep],
  ["claim", claim],
  // Writes state and nothing else; queued comments ride along on every op (see main).
  ["save-state", saveState],
  // Writes a spec too long for the saved state to spec.md in the run dir (#280).
  ["save-spec", saveSpec],
  ["ask", ask],
  ["split", split],
  // Stop an issue at a failed control: label it agent:stopped-<code>, and explain
  // on the issue and its PR which control stopped it, why, and how to resume.
  ["stop", stop],
  ["verify", verify],
  ["wiki-check", wikiCheck],
  ["ci-status", ciStatus],
  ["merge", merge],
  ...Object.entries(publishOps),
  ["close-parent", closeParent],
  ["finish-wiki", finishWiki],
  ["post", post],
  ["release", release],
  // Frees closed issues' worktrees once nothing local is unsaved (#174).
  ["cleanup", cleanup],
  // Appends a role job's usage record to the issue's usage comments (#302).
  ["usage", usage],
]);

// The request runs to the last END marker, not the first: the JSON can carry the
// marker words inside a string, such as a plan or spec about this protocol (#176).
const OPS_REQUEST = /BEGIN_OPS_REQUEST\s*(?<json>[\s\S]*)END_OPS_REQUEST/u;
const MAX_ERROR_LENGTH = 4000;

// The fields every request carries, whatever its op: the op, the config's
// path, the signed comments the workflow queued for the issue and, from a
// stage job, its checkout.
const ENVELOPE = z.looseObject({
  comments: z
    .array(
      z.looseObject({
        body: z.string(),
        by: AUTHOR.nullish(),
        // A keyed comment is written once: a later one with the same key
        // edits it (commentByKey).
        key: z.string().nullish(),
        number: z.number().int(),
      }),
    )
    .nullish(),
  config: z.string().nullish(),
  op: z.string(),
  // A stage job's own checkout, which stands in for its issue's worktree.
  checkout: z
    .object({ issue: z.number().int(), dir: z.string().min(1) })
    .nullish(),
});

// The JSON request framed on stdin. Read as a stream, since fd 0 can be a
// non-blocking pipe whose data arrives late, which a synchronous read answers
// with EAGAIN (#263).
async function readRequest(): Promise<unknown> {
  const groups = OPS_REQUEST.exec(await text(process.stdin))?.groups;
  const { json } = groups ?? {};
  if (json === undefined) {
    throw new OpsError(
      "no BEGIN_OPS_REQUEST ... END_OPS_REQUEST block on stdin",
    );
  }
  const request: unknown = JSON.parse(json);
  return request;
}

// Runs a parsed request: its queued comments, then its op.
function runRequest(request: unknown): OpsReply {
  const { checkout, comments, config, op } = parseRequest(
    ENVELOPE,
    "ops",
    request,
  );
  const handler = OPS.get(op);
  if (handler === undefined) {
    throw new OpsError(`unknown op "${op}"`);
  }
  const cfg = withCheckout(loadConfig(config ?? undefined), checkout);
  fs.mkdirSync(ROOT, { recursive: true });
  // Post the signed comments the workflow queued for this issue before running the op,
  // so they land in order and aren't lost if the op fails.
  let posted = 0;
  for (const { body, by, key, number } of comments ?? []) {
    if (typeof key === "string") {
      commentByKey(cfg, number, by ?? undefined, { body, key });
    } else {
      comment(cfg, number, by ?? undefined, body);
    }
    posted += 1;
  }
  return { ok: true, op, posted, ...handler(cfg, request) };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return String(error);
}

function stackOf(error: unknown): string {
  if (error instanceof Error && error.stack !== undefined) {
    return error.stack;
  }
  return String(error);
}

// The reply to stdin's request. A crash, an error that is neither an OpsError
// nor unreadable JSON, also writes its stack to stderr.
async function reply(): Promise<OpsReply | ErrorReply> {
  try {
    return runRequest(await readRequest());
  } catch (error: unknown) {
    if (!(error instanceof OpsError || error instanceof SyntaxError)) {
      process.stderr.write(stackOf(error));
    }
    return { ok: false, error: messageOf(error).slice(0, MAX_ERROR_LENGTH) };
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await reply())}\n`);
}

await main();
