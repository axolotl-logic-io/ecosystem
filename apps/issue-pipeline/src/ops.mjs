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
import {
  branchHasWork,
  ensureClone,
  ensureWorktree,
  fetchIn,
  remoteHead,
  removeWorktree,
} from "./checkouts.ts";
import {
  closeClaims,
  laneOf,
  leaseLane,
  raceForClaim,
} from "./claims.ts";
import {
  AFTER_MARK,
  comment,
  listComments,
  PARENT_MARK,
  pipelineRole,
  signed,
} from "./comments.ts";
import { loadConfig, paths, publicConfig } from "./config.ts";
import { gh, ghJson, isAllowedUser } from "./github.ts";
import { writeIssueContext } from "./issue-context.ts";
import {
  clearStopLabels,
  ensureLabels,
  isPipelineLabel,
  LABELS,
  setLabels,
} from "./labels.ts";
import { RESERVATION_MS, withRepoLock } from "./locks.ts";
import { ciStatus } from "./ops/ci-status.ts";
import { closeParent, post, release } from "./ops/finish.ts";
import { merge } from "./ops/merge.ts";
import { prOps } from "./ops/pr.ts";
import { syncOps } from "./ops/sync.ts";
import { verify } from "./ops/verify.ts";
import { ROOT } from "./pipeline-root.ts";
import { OpsError, run, tail } from "./process.ts";
import { readState, startState, writeState } from "./state.ts";
import { isStopLabel, STOPS, stopFor } from "./stops.ts";
import { ensureWiki } from "./wiki.ts";
import { ask } from "./ops/ask.ts";
import { claim } from "./ops/claim.ts";
import { saveState } from "./ops/save-state.ts";
import { split } from "./ops/split.ts";
import { stop } from "./ops/stop.ts";
import { sweep } from "./ops/sweep.ts";

// ---------- operations ----------

const ops = {};
Object.assign(ops, prOps, syncOps);

ops.sweep = sweep;

ops.claim = claim;

// Writes state and nothing else; queued comments ride along on every op (see main).
ops["save-state"] = saveState;

ops.ask = ask;

ops.split = split;

// Stop an issue at a failed control: label it agent:stopped-<code>, and explain
// on the issue and its PR which control stopped it, why, and how to resume.
ops.stop = stop;

ops.verify = verify;

ops["ci-status"] = ciStatus;

ops.merge = merge;
ops["close-parent"] = closeParent;
ops.post = post;
ops.release = release;

// ---------- entry point ----------

// The request runs to the last END marker, not the first: the JSON can carry the
// marker words inside a string, such as a plan or spec about this protocol (#176).
const OPS_REQUEST = /BEGIN_OPS_REQUEST\s*([\s\S]*)END_OPS_REQUEST/u;

function main() {
  const raw = fs.readFileSync(0, "utf8");
  const m = raw.match(OPS_REQUEST);
  let reply;
  try {
    if (!m) throw new OpsError("no BEGIN_OPS_REQUEST ... END_OPS_REQUEST block on stdin");
    const req = JSON.parse(m[1]);
    const handler = ops[req.op];
    if (!handler) throw new OpsError(`unknown op "${req.op}"`);
    const cfg = loadConfig(req.config);
    fs.mkdirSync(ROOT, { recursive: true });
    // Post the signed comments the workflow queued for this issue before running the op,
    // so they land in order and aren't lost if the op fails.
    let posted = 0;
    for (const c of req.comments || []) {
      comment(cfg, c.number, c.by, c.body);
      posted++;
    }
    reply = { ok: true, op: req.op, posted, ...handler(cfg, req) };
  } catch (err) {
    if (!(err instanceof OpsError) && !(err instanceof SyntaxError)) {
      process.stderr.write(String(err?.stack || err));
    }
    reply = { ok: false, error: String(err?.message || err).slice(0, 4000) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

main();
