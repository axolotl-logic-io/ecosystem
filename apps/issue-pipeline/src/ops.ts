#!/usr/bin/env node
// Deterministic git and GitHub operations for the issue pipeline.
//
// Each stage job runs this file, installed as ops.mjs, as a child process
// (src/job/ops-process.ts). The request is one JSON object between
// BEGIN_OPS_REQUEST and END_OPS_REQUEST on stdin. The reply is one
// JSON line on stdout. Handled failures exit 0 with {"ok":false,...}; only
// crashes exit non-zero.
//
// No language model runs here. Authenticated calls select a verified credential
// through github.ts; config.ts alone reads the private operator file.
//
// Development owns commits, source pushes and PR lifecycle. Review/merge
// owns comments, state, claims, labels, authority reads and REST merge. Both are excluded from human trust;
// current merge authorship and editor provenance, not marks alone, confer
// operational authority.

import fs from "node:fs";
import process from "node:process";
import { text } from "node:stream/consumers";
import { z } from "zod";
import type { Config } from "./config.ts";
import { loadConfig, withCheckout } from "./config.ts";
import { INVOCATION_BINDING } from "./coordination-records.ts";
import { ask } from "./ops/ask.ts";
import { boundClaim } from "./ops/bound-claim.ts";
import { ciStatus } from "./ops/ci-status.ts";
import { claim } from "./ops/claim.ts";
import { cleanup } from "./ops/cleanup.ts";
import { confirmMergedOp } from "./ops/confirm-merged.ts";
import { currentRevisionOp } from "./ops/current-revision.ts";
import { boundOps, unboundOps } from "./ops/execution-envelope.ts";
import { closeParent, finishIssue } from "./ops/finish.ts";
import { integrationTaskOps } from "./ops/integration-task.ts";
import { merge } from "./ops/merge.ts";
import { post, postComments, QUEUED_COMMENT } from "./ops/post.ts";
import { prOps } from "./ops/pr.ts";
import { pushOps } from "./ops/push.ts";
import { reconcileLand } from "./ops/reconcile-land.ts";
import { release, saveState } from "./ops/save-state.ts";
import { stop } from "./ops/stop.ts";
import { syncOps } from "./ops/sync.ts";
import { syncTaskOps } from "./ops/sync-task.ts";
import { syncReconcileOps } from "./ops/sync-task-reconcile.ts";
import { taskReadinessOps } from "./ops/task-readiness.ts";
import { taskResultOps } from "./ops/task-results.ts";
import { usage } from "./ops/usage.ts";
import { verify } from "./ops/verify.ts";
import { OpsError } from "./ops-error.ts";
import { ROOT } from "./pipeline-root.ts";
import { parseRequest } from "./process.ts";
import { assertPolicyDigest } from "./project-policy.ts";

// An op reads its own fields from the whole request and returns its reply.
type Op = (cfg: Config, request: unknown) => object;

// The line printed for a request: the op's own reply follows ok, op, how
// many queued comments it posted and their ids in the request's order, or
// the error says why there is none.
interface OpsReply {
  ok: true;
  op: string;
  posted: number;
  commentIds: number[];
}

interface ErrorReply {
  ok: false;
  error: string;
}

const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  ...Object.entries(prOps),
  ...Object.entries(pushOps),
  // The retired merge-stage synchronization: no role calls these since #186
  // (OpName in job/role-context.ts); Sync is its own task below.
  ...Object.entries(syncOps),
  // Revision-bound task results (#183) and the next ready task (#186).
  ...Object.entries(taskResultOps),
  ...Object.entries(taskReadinessOps),
  // Hippy's Sync task (#184).
  ...Object.entries(syncTaskOps),
  ...Object.entries(syncReconcileOps),
  // Lawd's read-only Integration (#185).
  ...Object.entries(integrationTaskOps),
  // Merges code only, checkpointing attempt/response/receipt; never the issue.
  ["merge", merge],
  ["reconcile-merge", reconcileLand],
  // Completes an issue its merge role saved done and merged.
  ["finish", finishIssue],
  ["close-parent", closeParent],
  // A stage job's claim is bound to its confirmed invocation (#167); an
  // unbound one can read but not write (#169).
  [
    "claim",
    (cfg: Config, request: unknown): object => {
      if (cfg.execution === undefined) {
        return claim(cfg, request);
      }
      return boundClaim(cfg, request);
    },
  ],
  // Writes state and nothing else; queued comments ride along on every op (see main).
  ["save-state", saveState],
  ["ask", ask],
  // Stop an issue at a failed control: label it agent:stopped-<code>, and explain
  // on the issue and its PR which control stopped it, why, and how to resume.
  ["stop", stop],
  ["current-revision", currentRevisionOp],
  ["verify", verify],
  // Read-only post-Land confirmation of an own fast-forward's premerge proof.
  ["confirm-merged", confirmMergedOp],
  ["ci-status", ciStatus],
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
// stage job, its checkout and invocation binding (execution-envelope.ts).
const ENVELOPE = z.looseObject({
  comments: z.array(QUEUED_COMMENT).nullish(),
  config: z.string().nullish(),
  op: z.string(),
  number: z.number().int().positive().optional(),
  execution: INVOCATION_BINDING.optional(),
  // A job started for an assignment: the buddy account whose grant each
  // credentialed write rechecks (#119).
  grant: z.object({ login: z.string().min(1) }).optional(),
  policyDigest: z.string().optional(),
  // A stage job's own checkout, which stands in for its issue's worktree,
  // and the branch the caller assigned the issue (config.ts's JobCheckout).
  checkout: z
    .object({
      issue: z.number().int(),
      dir: z.string().min(1),
      branch: z.string().min(1),
    })
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
  const envelope = parseRequest(ENVELOPE, "ops", request);
  const { checkout, comments, config, op, policyDigest } = envelope;
  const handler = OPS.get(op);
  if (handler === undefined) {
    throw new OpsError(`unknown op "${op}"`);
  }
  let cfg = withCheckout(loadConfig(config ?? undefined), checkout);
  assertPolicyDigest(cfg, policyDigest);
  if (envelope.execution === undefined) {
    cfg = unboundOps(cfg);
  } else {
    if (envelope.grant !== undefined) {
      cfg = { ...cfg, grant: envelope.grant };
    }
    cfg = boundOps(cfg, envelope.execution, envelope);
  }
  fs.mkdirSync(ROOT, { recursive: true });
  // Post the signed comments the workflow queued for this issue before running the op,
  // so they land in order and aren't lost if the op fails.
  const commentIds = postComments(cfg, comments ?? []);
  const posted = commentIds.length;
  return { ok: true, op, posted, commentIds, ...handler(cfg, request) };
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
