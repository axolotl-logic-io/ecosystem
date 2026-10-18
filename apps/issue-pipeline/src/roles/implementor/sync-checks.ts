// The start sync's script checks (#419), for one run of the implementor's
// machine: whether the branch lacks its target's head, the rebase through
// sync-base, the resolver's reply, the role's own `rebase --continue` in the
// job's checkout, the finish (or abort) through finish-sync, and whether the
// `sync` entry's sync moved the head. A sync that ends answers with the
// run's entry and the head, flows and stack it leaves; a failed op fails its
// check, which the runner ends.

import { z } from "zod";
import type { Config } from "../../config.ts";
import { withCheckout } from "../../config.ts";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import { run } from "../../process.ts";
import { rebaseInProgress, unmergedFiles } from "../../rebase.ts";
import { syncTarget } from "../../stack.ts";
import { flowsOf } from "../../workflow/flows.ts";
import {
  finishReplyOf,
  fixOf,
  isRecord,
  syncReplyOf,
} from "../../workflow/stages/checks-reply.ts";
import { finishRequest } from "../../workflow/stages/conflict-target.ts";
import { stackedOnOf, stackFields } from "../../workflow/stages/stacked.ts";
import type { Checks, JobEffects } from "../registry.ts";
import { codeChangedSince } from "./code-change.ts";
import { answer, guarded } from "./outcome.ts";

type Payload = CheckEffect["payload"];
type Reply = Readonly<Record<string, unknown>>;

const STACKED_ON = z.object({ issue: z.number(), headSha: z.string() });
const SYNC = z.looseObject({
  number: z.number(),
  entry: z.string(),
  stackedOn: STACKED_ON.nullable(),
});
const SYNC_WORK = SYNC.extend({ specTestsSha: z.string().nullable() });
const FINISH = z.looseObject({
  number: z.number(),
  entry: z.string(),
  baseSha: z.string().nullable(),
  stackedOn: STACKED_ON.nullable(),
});
const ABORT = z.looseObject({ number: z.number(), reason: z.string() });
const CHANGES = z.looseObject({
  codeChanged: z.boolean(),
  wikiAhead: z.number(),
});
const MOVED = z.looseObject({ changed: z.boolean() });

function git(dir: string, args: readonly string[]): ReturnType<typeof run> {
  const env = new Map([
    ["GIT_EDITOR", "true"],
    ["ISSUE_PIPELINE_COMMIT", "1"],
  ]);
  return run("git", ["-C", dir, ...args], { allowFail: true, env });
}

// What a sync that ends answers with: the head, the flows when the op
// reported them, and the stack when the reply names one.
function ended(entry: string, reply: Reply, headSha: string): Outcome {
  const changes = CHANGES.safeParse(reply);
  let flows: Reply = {};
  if (changes.success) {
    flows = { flows: flowsOf(changes.data) };
  }
  let stack: Reply = {};
  const stackedOn = stackedOnOf(reply);
  if (stackedOn !== undefined) {
    stack = { stackedOn };
  }
  return answer(entry, { headSha, ...flows, ...stack });
}

// `work` when the branch in `dir` lacks its target's head, with the head
// before the rebase and whether it has no code change since the spec's
// tests; otherwise the entry, with the head and, for a stacked issue, what
// it is stacked on.
function syncWork(cfg: Config, dir: string, payload: Payload): Outcome {
  const { entry, stackedOn, specTestsSha } = SYNC_WORK.parse(payload);
  const target = syncTarget(cfg, dir, stackedOn);
  const has = git(dir, ["merge-base", "--is-ancestor", target.onto, "HEAD"]);
  const headSha = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  if (has.code !== 0) {
    let specAtHead = false;
    if (specTestsSha !== null) {
      specAtHead = codeChangedSince(dir, specTestsSha, headSha) === false;
    }
    return answer("work", { headSha, specAtHead });
  }
  let reply: Reply = {};
  if (stackedOn !== null) {
    reply = { stackedOn: target.stackedOn };
  }
  return ended(entry, reply, headSha);
}

function recordOf(reply: unknown): Reply {
  if (isRecord(reply)) {
    return reply;
  }
  return {};
}

// Rebases with sync-base, keeping a conflicting rebase stopped for the
// resolver; sync-base pushes a clean one itself.
async function rebased(
  effects: JobEffects,
  payload: Payload,
): Promise<Outcome> {
  const { number, entry, stackedOn } = SYNC.parse(payload);
  const fields = { number, keepConflict: true, ...stackFields(stackedOn) };
  const done = await effects.op({
    kind: "op",
    op: "sync-base",
    payload: fields,
  });
  if (!done.ok) {
    return done;
  }
  const raw = recordOf(done.reply);
  const reply = syncReplyOf(raw);
  switch (reply.kind) {
    case "failed":
      return { ok: false, error: reply.error ?? "sync-base failed" };
    case "conflict": {
      if (!reply.inRebase) {
        return { ok: false, error: "sync-base left no rebase to resolve" };
      }
      const { conflicts: files, baseSha = null } = reply;
      return answer("conflict", {
        files,
        baseSha,
        stackedOn: stackedOnOf(raw),
      });
    }
    case "clean":
      return ended(entry, raw, reply.headSha);
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

function resolverAnswer(payload: Payload): Outcome {
  const { reading } = payload;
  const read = fixOf(reading);
  if (read === null) {
    return answer("bad");
  }
  return answer(read.status);
}

// Continues the resolved rebase in `dir`: `clean` once it finishes, or
// `conflict` with the files of the next commit that stops.
function continued(dir: string): Outcome {
  git(dir, ["rebase", "--continue"]);
  if (rebaseInProgress(dir)) {
    return answer("conflict", { files: unmergedFiles(dir) });
  }
  return answer("clean");
}

// Finishes the resolved rebase with finish-sync, which checks and pushes it.
async function finished(
  effects: JobEffects,
  payload: Payload,
): Promise<Outcome> {
  const { number, entry, baseSha, stackedOn } = FINISH.parse(payload);
  const finish = { number, abort: false, reason: "resolved", baseSha };
  const { op, payload: request } = finishRequest(
    { kind: "code", stackedOn },
    finish,
  );
  const done = await effects.op({ kind: "op", op, payload: request });
  if (!done.ok) {
    return done;
  }
  const raw = recordOf(done.reply);
  const reply = finishReplyOf(raw);
  switch (reply.kind) {
    case "failed":
      return { ok: false, error: reply.error ?? "finish-sync failed" };
    case "rejected":
      return answer("rejected", { reason: reply.reason });
    case "resolved":
      return ended(entry, { ...raw, stackedOn }, reply.headSha);
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

// Aborts the rebase with finish-sync, which resets the checkout to the
// pushed branch.
async function aborted(
  effects: JobEffects,
  payload: Payload,
): Promise<Outcome> {
  const { number, reason } = ABORT.parse(payload);
  const done = await effects.op({
    kind: "op",
    op: "finish-sync",
    payload: { number, abort: true, reason },
  });
  if (!done.ok) {
    return done;
  }
  return answer("aborted");
}

function moved(payload: Payload): Outcome {
  if (MOVED.parse(payload).changed) {
    return answer("moved");
  }
  return answer("same");
}

// The start sync's checks for issue `issue`, with ops through `effects`, and
// git in the job's checkout `dir`.
function syncChecks(
  effects: JobEffects,
  cfg: Config,
  job: { issue: number; dir: string },
): Checks {
  const { dir } = job;
  const jobCfg = withCheckout(cfg, job);
  return {
    "sync-work?": (payload: Payload) =>
      guarded(() => syncWork(jobCfg, dir, payload)),
    rebase: (payload: Payload) => guarded(() => rebased(effects, payload)),
    "resolver-reply": (payload: Payload) =>
      guarded(() => resolverAnswer(payload)),
    continue: () => guarded(() => continued(dir)),
    "finish-sync": (payload: Payload) =>
      guarded(() => finished(effects, payload)),
    abort: (payload: Payload) => guarded(() => aborted(effects, payload)),
    "sync-moved?": (payload: Payload) => guarded(() => moved(payload)),
  };
}

export { syncChecks };
