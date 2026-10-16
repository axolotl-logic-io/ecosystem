// The sweep's launches as pi-subagents runs them. An ops request is framed
// for the ops agent, with the issue's queued comments riding along; a model
// session runs in the issue's worktree with no way to ask a question.

import type { JobCheckout } from "../config.ts";
import type { JsonSchema } from "./schemas.ts";
import type { LaunchMeta, Signature } from "./signing.ts";
import type { ChildLaunch, OpLaunch } from "./stages/types.ts";

const OPS_AGENT = "issue-pipeline-ops";
const MINUTE_MS = 60_000;
const OPS_MINUTES = 10;
const CHILD_MINUTES = 30;
const WRITER_ACCEPTANCE: WriterAcceptance = {
  level: "none",
  reason: "The pipeline verifies changes with its own commands and reviewers.",
};

// What every ops request names besides its op: the repo config, the sweep
// and its lane, and a stage job's own checkout (#250).
interface OpsFrame {
  config: string;
  sweepId: string;
  lane: string;
  checkout?: JobCheckout;
}

// A signed comment waiting to ride on the next ops request for its issue.
interface QueuedComment {
  number: number;
  by: Signature;
  body: string;
}

// The sweep's issue and the comments queued for it.
interface Outbox {
  number: number;
  comments: QueuedComment[];
}

interface OpsSpec {
  key: string;
  label: string;
  agent: string;
  task: string;
  timeoutMs: number;
  control: { needsAttentionAfterMs: number };
}

interface WriterAcceptance {
  level: "none";
  reason: string;
}

interface ChildSpec {
  key: string;
  label: string;
  agent: string;
  model: string;
  cwd: string;
  task: string;
  outputSchema: JsonSchema;
  timeoutMs: number;
  // The session's token budget; the stage job records it in job.json.
  tokenBudget: number;
  intercomBridge: { mode: "off" };
  acceptance?: WriterAcceptance;
}

type LaunchSpec = OpsSpec | ChildSpec;

// The timeout in milliseconds: `minutes`, or `fallback` when it is missing or 0.
function timeoutOf(minutes: number | undefined, fallback: number): number {
  if (minutes === undefined || minutes === 0) {
    return fallback * MINUTE_MS;
  }
  return minutes * MINUTE_MS;
}

// The comments queued for the issue the launch's payload names, taken from
// the outbox, as the request's `comments` field.
function ridingComments(
  launch: OpLaunch,
  outbox: Outbox | null,
): { comments?: QueuedComment[] } {
  const { number } = launch.payload;
  if (
    outbox === null ||
    number !== outbox.number ||
    outbox.comments.length === 0
  ) {
    return {};
  }
  return { comments: outbox.comments.splice(0, outbox.comments.length) };
}

// The frame of a sweep's requests. It names a checkout only when `args`
// carries one, so workflow.js's requests stay as they were.
function opsFrame(
  args: { config: string; checkout?: JobCheckout | undefined },
  sweepId: string,
  lane: string,
): OpsFrame {
  const frame: OpsFrame = { config: args.config, sweepId, lane };
  if (args.checkout !== undefined) {
    frame.checkout = args.checkout;
  }
  return frame;
}

// The ops request for `launch`, keyed "<name>-<seq>". The comments queued for
// the issue it names ride along, and leave the outbox.
function opsSpec(
  frame: OpsFrame,
  seq: number,
  launch: OpLaunch,
  outbox: Outbox | null,
): OpsSpec {
  const { op, payload, minutes } = launch;
  const request = {
    op,
    ...frame,
    ...payload,
    ...ridingComments(launch, outbox),
  };
  const timeoutMs = timeoutOf(minutes, OPS_MINUTES);
  return {
    key: `${launch.name}-${seq}`,
    label: `Run ${op} operation`,
    agent: OPS_AGENT,
    task: `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`,
    timeoutMs,
    // ops prints nothing until it finishes, so the default 60 s silence alert
    // would fire on every verify and CI wait. The timeout already bounds it.
    control: { needsAttentionAfterMs: timeoutMs },
  };
}

// The model session for `launch` on issue `n`, keyed "i<n>-<name>-<seq>". Its
// agent and model are recorded in `meta` for the signature on its result.
function childSpec(
  seq: number,
  item: { n: number; worktree: string },
  launch: ChildLaunch,
  meta: Record<string, LaunchMeta>,
): ChildSpec {
  const spec: ChildSpec = {
    key: `i${item.n}-${launch.name}-${seq}`,
    label: launch.label,
    agent: launch.agent,
    model: launch.model,
    cwd: item.worktree,
    task: launch.task,
    outputSchema: launch.schema,
    timeoutMs: timeoutOf(launch.minutes, CHILD_MINUTES),
    tokenBudget: launch.tokenBudget,
    // pi-subagents gives every child contact_supervisor unless the bridge is
    // off. No one answers an unattended sweep, so a question would hang.
    intercomBridge: { mode: "off" },
  };
  if (launch.writer === true) {
    spec.acceptance = WRITER_ACCEPTANCE;
  }
  meta[spec.key] = { agent: launch.agent, model: launch.model };
  return spec;
}

export type { ChildSpec, LaunchSpec, OpsFrame, OpsSpec, Outbox, QueuedComment };
export { childSpec, opsFrame, opsSpec };
