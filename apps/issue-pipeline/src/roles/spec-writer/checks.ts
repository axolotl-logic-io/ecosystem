// The spec writer's script checks (the wiki's Pipeline-Roles-Spec-Writer,
// "Lifecycle"), for one run of its machine: the reply check with interface
// coverage, the commit check, the no-work test run, the start heads and the
// reset (checks-git.ts), the spec's publication through the post and
// save-spec ops, and the close of an earlier PR. Each answers with one of the
// machine's result names; a failure's reason is its reply, which the retry's
// task includes. The job has already claimed the issue, so the claim and the
// retry answer ok.

import { z } from "zod";
import type { Config } from "../../config.ts";
import { withCheckout } from "../../config.ts";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { specSection } from "../../spec-sections.ts";
import { clip } from "../../workflow/clip.ts";
import type { Checks, JobEffects } from "../registry.ts";
import type { SpecJob } from "./checks-git.ts";
import {
  noWorkConfirmed,
  resetBranches,
  specTestsAtHead,
  startHeads,
} from "./checks-git.ts";
import { interfaceGaps } from "./coverage.ts";
import { wikiOnly } from "./locate.ts";

type Payload = CheckEffect["payload"];

// The longest spec the state keeps; a longer one is saved whole to spec.md.
const SPEC_LIMIT = 12_000;
const SPEC_INTRO =
  "## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.";

const SHA = z.string().nullable();
const INTERFACE = z.looseObject({
  name: z.string(),
  where: z.string(),
  status: z.enum(["existing", "new", "changed"]),
  behaviours: z.array(z.string()),
});
const READY = z.looseObject({
  spec: z.string(),
  files: z.array(z.string()),
  interfaces: z.array(INTERFACE),
  noTestsReason: z.string().nullable(),
});
const READING = z.looseObject({
  kind: z.string(),
  reason: z.string().optional(),
  reply: z.unknown(),
});
const COMMITS = READY.omit({ spec: true }).extend({ startSha: SHA });
const HEADS = z.looseObject({ startSha: SHA, startWikiSha: SHA });
const RESET = HEADS.extend({ reading: READING });
const SAVED_SPEC = z.looseObject({ specFile: z.string() });

function answer(name: string, reply: unknown = null): Outcome {
  return { ok: true, name, reply };
}

function ok(): Promise<Outcome> {
  return Promise.resolve(answer("ok"));
}

// Why a ready reply fails before its commits are checked, or null.
function readyFault(reply: unknown): string | null {
  const parsed = READY.safeParse(reply);
  if (!parsed.success) {
    return "the ready reply has no spec, files or interfaces";
  }
  const { spec, interfaces, noTestsReason } = parsed.data;
  if (specSection(spec, "Behaviour").length === 0) {
    return "the spec has no Behaviour section";
  }
  const gaps = interfaceGaps(spec, interfaces);
  if (noTestsReason === null && gaps.length > 0) {
    const list = gaps.map((item) => `- ${item}`).join("\n");
    return `No test interface quotes these Behaviour items in its behaviours:\n${list}`;
  }
  return null;
}

function checkReply(payload: Payload): Outcome {
  const { reading } = payload;
  const parsed = READING.safeParse(reading);
  if (!parsed.success) {
    return answer("bad", "the session's reply wasn't read");
  }
  const { kind, reason, reply } = parsed.data;
  if (kind === "bad") {
    return answer("bad", reason ?? "the reply was malformed");
  }
  if (kind !== "ready") {
    return answer(kind);
  }
  const fault = readyFault(reply);
  if (fault !== null) {
    return answer("bad", fault);
  }
  return answer("ready");
}

// Runs `act`, and turns a thrown error into a failed outcome.
async function guarded(
  act: () => Promise<Outcome> | Outcome,
): Promise<Outcome> {
  try {
    return await act();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function op(
  effects: JobEffects,
  name: string,
  payload: Payload,
): Promise<Outcome> {
  return effects.op({ kind: "op", op: name, payload });
}

// Posts the spec as the issue's `## Spec` comment, saving a spec too long
// for the state to spec.md first, and answers whether it is wiki-only.
async function publish(
  entry: Entry,
  effects: JobEffects,
  payload: Payload,
): Promise<Outcome> {
  const { issue: number, paths } = entry.context;
  const { spec, files, noTestsReason } = READY.parse(payload);
  let specFile: string | null = null;
  if (spec.length > SPEC_LIMIT) {
    const saved = await op(effects, "save-spec", { number, spec });
    if (!saved.ok) {
      return saved;
    }
    ({ specFile } = SAVED_SPEC.parse(saved.reply));
  }
  const body = `${SPEC_INTRO}\n\n${spec}`;
  const { by } = payload;
  const comment = { number, by, body, key: "spec" };
  const posted = await op(effects, "post", { comments: [comment] });
  if (!posted.ok) {
    return posted;
  }
  let kind = "code";
  if (wikiOnly({ files, noTestsReason }, paths)) {
    kind = "wiki-only";
  }
  return answer(kind, { spec: clip(spec, SPEC_LIMIT), specFile });
}

// Closes the PR an earlier spec of the issue opened, if it saved one.
async function closeOldPr(entry: Entry, effects: JobEffects): Promise<Outcome> {
  const { pr } = entry.saved;
  if (typeof pr !== "number") {
    return answer("ok");
  }
  const closed = await op(effects, "close-pr", {
    number: entry.context.issue,
    pr,
  });
  if (!closed.ok) {
    return closed;
  }
  return answer("ok");
}

function specTests(job: SpecJob, payload: Payload): Outcome {
  const result = specTestsAtHead(job, COMMITS.parse(payload));
  if (!result.pass) {
    return answer("fail", `${result.rule}: ${result.reason}`);
  }
  return answer("pass", { sha: result.sha });
}

function confirmNoWork(job: SpecJob, payload: Payload): Outcome {
  const { startSha } = COMMITS.pick({ startSha: true }).parse(payload);
  const judged = noWorkConfirmed(job, startSha);
  if (!judged.pass) {
    const why = "the no-work reply's tests fail at the head";
    return answer("fail", `${why}:\n${judged.output}`);
  }
  return answer("pass");
}

function reset(job: SpecJob, payload: Payload): Outcome {
  const { startSha, startWikiSha, reading } = RESET.parse(payload);
  resetBranches(job, { startSha, startWikiSha });
  return answer(reading.kind);
}

// The spec writer's checks for the run from `entry`, with ops through
// `effects` and git and the commands in the job's checkout of `cfg`.
function specWriterChecks(
  entry: Entry,
  effects: JobEffects,
  cfg: Config,
): Checks {
  const { issue: n, paths } = entry.context;
  const jobCfg = withCheckout(cfg, { issue: n, dir: paths.worktree });
  const stackedOn = entry.saved.stackedOn?.issue ?? null;
  const job: SpecJob = { cfg: jobCfg, n, stackedOn };
  return {
    claim: ok,
    retry: ok,
    checkout: () => guarded(() => answer("ok", startHeads(jobCfg, n))),
    "check-reply": (payload: Payload) => guarded(() => checkReply(payload)),
    "spec-tests-check": (payload: Payload) =>
      guarded(() => specTests(job, payload)),
    "confirm-no-work": (payload: Payload) =>
      guarded(() => confirmNoWork(job, payload)),
    reset: (payload: Payload) => guarded(() => reset(job, payload)),
    "publish-spec": (payload: Payload) =>
      guarded(() => publish(entry, effects, payload)),
    "close-old-pr": () => guarded(() => closeOldPr(entry, effects)),
  };
}

export { specWriterChecks };
