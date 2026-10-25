// Frames an action's request for installed ops.mjs with its trusted config,
// invocation binding and checkout. Each child launch has an `<op>-<seq>`
// key and resolves to the op's reply or failure. This module owns the wire
// framing, not task prerequisites or authorization.

import { z } from "zod";
import type { Config, JobCheckout } from "../config.ts";
import type { InvocationBinding } from "../coordination.ts";
import { policyRevision } from "../project-policy.ts";
import type { BuddyEnvelope } from "../runtime/buddy-config.ts";
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

// Every request carries its repository config, ownership binding and
// action checkout. sweepId/lane are retained transport labels, not
// assignment, lease or stage authority.
interface OpsFrame {
  config: string;
  policyDigest?: string;
  sweepId: string;
  lane: string;
  execution: InvocationBinding;
  checkout: JobCheckout;
  // A buddy action's trusted authorization (src/runtime/buddy-config.ts's
  // BuddyEnvelope), which ops rereads before its bound task ops.
  buddy?: BuddyEnvelope;
}

function opsFrameOf(
  cfg: Config,
  config: string,
  claimant: { sweepId: string; lane: string; execution: InvocationBinding },
  checkout: JobCheckout,
): OpsFrame {
  const frame: OpsFrame = {
    config,
    ...claimant,
    checkout,
    policyDigest: policyRevision(cfg).policy,
  };
  return frame;
}

// An op's reply: its fields after `ok`, or why it failed.
type OpsReply =
  | { ok: true; reply: Readonly<Record<string, unknown>> }
  | { ok: false; error: string };

// Runs one op with `payload` for the action's issue, which every request
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

// The action's op runner: each child gets a sequence key, runs through
// launch hooks and records its settlement in the launch registry.
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
    // The frame goes after the payload, so no payload field can stand in
    // for the op, the config, the binding, the checkout or the buddy.
    const request = { ...payload, op, ...frame, number: issue };
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
export { opsFrameOf, opsRunnerOf };
