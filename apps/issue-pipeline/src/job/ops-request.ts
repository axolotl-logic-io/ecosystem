// How a stage job runs its ops: each request is framed for the installed
// ops CLI (`src/ops.ts`) with the config, the claimant and the job's own
// checkout, runs as one launch keyed `<op>-<seq>` in job.json, and resolves
// to the op's reply or to why it failed. It never rejects. This module alone
// knows the request's framing and the reply's shape on stdout.

import { z } from "zod";
import type { Execution } from "../assignment/schema.ts";
import type { JobCheckout } from "../config.ts";
import type { LaunchHooks } from "./launch.ts";
import { runOpsLaunch } from "./launch.ts";
import type { OpsRaw } from "./raw-results.ts";
import type { JobStatus } from "./status.ts";

const MINUTE_MS = 60_000;
// An op's timeout unless its caller names one.
const OPS_MINUTES = 10;
// How much of an ops child's output a reply that wasn't JSON keeps.
const OUTPUT_TAIL = 500;
const REPLY = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

// What every request names besides its op: the repo config's path, the
// claimant (`sweepId` and `lane`, which the claim's lease records) and the
// job's own checkout, with the issue branch its caller assigned.
interface OpsFrame {
  config: string;
  execution?: Execution | undefined;
  sweepId: string;
  lane: string;
  checkout: JobCheckout;
}

// An op's reply: its fields after `ok`, or why it failed.
type OpsReply =
  | { ok: true; reply: Readonly<Record<string, unknown>> }
  | { ok: false; error: string };

// Runs one op with `payload` for the job's issue, which every request
// names as `number`, timed out after `minutes` (10 without).
type RunOp = (
  op: string,
  payload: object,
  minutes?: number,
) => Promise<OpsReply>;

// The reply a line of an ops child's output holds, or null when the line
// doesn't parse as one.
function lineReply(line: string): OpsReply | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const reply = REPLY.safeParse(parsed);
  if (!reply.success) {
    return null;
  }
  if (reply.data.ok) {
    return { ok: true, reply: reply.data };
  }
  const error = reply.data.error ?? "the op failed with no error";
  return { ok: false, error };
}

// The ops reply in a finished ops child's output: the last line that is a
// JSON object, scanning up from the end and stopping at the first line that
// opens like one but doesn't parse.
function replyOf(raw: OpsRaw): OpsReply {
  if (!raw.ok) {
    return {
      ok: false,
      error: `ops child failed: ${raw.error || "no detail"}`,
    };
  }
  const lines = raw.output.trim().split("\n").reverse();
  const object = lines
    .map((entry) => entry.trim())
    .find((line) => line.startsWith("{"));
  const notJson: OpsReply = {
    ok: false,
    error: `ops reply was not JSON: ${raw.output.slice(-OUTPUT_TAIL)}`,
  };
  if (object === undefined) {
    return notJson;
  }
  return lineReply(object) ?? notJson;
}

// The job's op runner for issue `issue`: each op gets the next sequence
// number in its key, runs through `hooks`, and its outcome goes in
// job.json.
function opsRunnerOf(
  issue: number,
  frame: OpsFrame,
  watch: { hooks: LaunchHooks; status: Pick<JobStatus, "settled"> },
): RunOp {
  let seq = 0;
  return async (
    op: string,
    payload: object,
    minutes = OPS_MINUTES,
  ): Promise<OpsReply> => {
    seq += 1;
    const key = `${op}-${seq}`;
    const request = { op, ...frame, ...payload, number: issue };
    const framed = `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`;
    const raw = await runOpsLaunch(
      { key, request: framed, timeoutMs: minutes * MINUTE_MS },
      watch.hooks,
    );
    const reply = replyOf(raw);
    let outcome: "ok" | "failed" = "failed";
    if (reply.ok) {
      outcome = "ok";
    }
    watch.status.settled(key, outcome);
    return reply;
  };
}

export type { OpsFrame, OpsReply, RunOp };
export { opsRunnerOf };
