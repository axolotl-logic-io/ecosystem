// The spec writer role as a state machine (`role-state-machines`; the wiki's
// Pipeline-Roles-Spec-Writer, "Lifecycle"): its table, its limits and its
// pure transition. Only `session` runs a model. Ops answer `ok`, the session
// `replied` or `failed`, and a state that routes on what it found is a check
// that names its result. The ops and checks are carried out by the job; this
// module only names them with their payloads. The registry runs it for
// `--stage spec` (src/roles/registry.ts, #334).

import type { SweepConfig } from "../../workflow/stages/types.ts";
import type {
  Edge,
  Guard,
  Limits,
  MachineState,
  Result,
  SessionEffect,
  StateSpec,
  Step,
  Table,
} from "../machine.ts";
import { transitionOf } from "../machine.ts";
import type { Machine } from "../walk.ts";
import {
  decided,
  failed,
  found,
  prOpened,
  published,
  read,
  readied,
  started,
  testsCommitted,
} from "./edges.ts";
import { END_STATES } from "./ends.ts";
import type { SpecData, SpecState } from "./locate.ts";
import { locate } from "./locate.ts";
import { prBodyOf } from "./pr.ts";
import { specSession } from "./task.ts";

// The results the states answer with.
type SpecResult =
  | "ok"
  | "not-ours"
  | "replied"
  | "failed"
  | "ready"
  | "no-work"
  | "needs-info"
  | "split"
  | "refused"
  | "bad"
  | "pass"
  | "fail"
  | "code"
  | "wiki-only"
  | "handoff";

type Spec = StateSpec<SpecState, SpecResult, SpecData>;
type Payload = Readonly<Record<string, unknown>>;

// At most 2 sessions per issue, counted across crash restarts (a lifted
// stop's restart resets the counts), besides the continuations after a
// handoff: the config's maxContinuations (limitsOf), 1 by default.
const LIMITS: Readonly<Record<string, number>> = {
  specAttempts: 2,
  specContinuations: 1,
};

// The no-work comment's key.
const NO_WORK_KEY = "no-work";

const ATTEMPTS: Guard<SpecState, SpecData> = {
  field: "attempts",
  limit: "specAttempts",
  over: "failed-twice",
};

const CONTINUATIONS: Guard<SpecState, SpecData> = {
  field: "continuations",
  limit: "specContinuations",
  over: "out-of-room",
};

function check(
  name: string,
  payload: (data: SpecData) => Payload,
  on: Spec["on"],
): Spec {
  return {
    kind: "script",
    effect: (data: SpecData) => ({
      kind: "check",
      check: name,
      payload: { number: data.issue, ...payload(data) },
    }),
    on,
  };
}

function op(
  name: string,
  payload: (data: SpecData) => Payload,
  edge: Edge<SpecState, SpecData>,
): Spec {
  return {
    kind: "script",
    effect: (data: SpecData) => ({
      kind: "op",
      op: name,
      payload: { number: data.issue, ...payload(data) },
    }),
    on: { ok: edge },
  };
}

function session(data: SpecData): SessionEffect {
  return specSession(
    {
      n: data.issue,
      paths: data.settings.paths,
      depth: data.depth,
      plan: data.plan,
      splitSuggested: data.splitSuggested,
      attempt: data.attempts,
      checkOutput: data.checkOutput,
      committed: data.committed,
      continued: data.reply?.kind === "handoff",
      startSha: data.startSha ?? null,
    },
    data.settings,
  );
}

const SCRIPT_STATES = {
  claim: check("claim", () => ({}), {
    ok: { to: "checkout" },
    "not-ours": { to: "released" },
  }),
  checkout: check(
    "checkout",
    (data: SpecData) => ({
      startSha: data.startSha,
      startWikiSha: data.startWikiSha,
    }),
    { ok: { to: "session", apply: started, count: ATTEMPTS } },
  ),
  "check-reply": check(
    "check-reply",
    (data: SpecData) => ({ reading: data.reply }),
    {
      ready: { to: "check-commits", apply: readied },
      "no-work": { to: "confirm-no-work" },
      "needs-info": { to: "reset" },
      split: { to: "reset" },
      refused: { to: "reset" },
      bad: { to: "retry", apply: failed },
      handoff: { to: "resume", count: CONTINUATIONS },
    },
  ),
  resume: check(
    "spec-commits",
    (data: SpecData) => ({
      startSha: data.startSha,
      startWikiSha: data.startWikiSha,
    }),
    { ok: { to: "session", apply: found } },
  ),
  "check-commits": check(
    "spec-tests-check",
    (data: SpecData) => ({
      startSha: data.startSha,
      wikiOnly: data.wikiOnly,
      interfaces: data.interfaces,
      noTestsReason: data.noTestsReason,
    }),
    {
      pass: { to: "publish-spec", apply: testsCommitted },
      fail: { to: "retry", apply: failed },
    },
  ),
  "confirm-no-work": check(
    "confirm-no-work",
    (data: SpecData) => ({ startSha: data.startSha }),
    { pass: { to: "reset" }, fail: { to: "retry", apply: failed } },
  ),
  retry: check(
    "retry",
    (data: SpecData) => ({
      attempts: data.attempts,
      checkOutput: data.checkOutput,
    }),
    { ok: { to: "session", count: ATTEMPTS } },
  ),
  reset: check(
    "reset",
    (data: SpecData) => ({
      startSha: data.startSha,
      startWikiSha: data.startWikiSha,
      reading: data.reply,
    }),
    {
      "needs-info": { to: "ask" },
      split: { to: "split" },
      "no-work": { to: "stop-no-work" },
      refused: { to: "split-refused" },
    },
  ),
  ask: op(
    "ask",
    (data: SpecData) => {
      const { questions, spec } = decided(data);
      return { by: data.by, questions, spec };
    },
    { to: "asked" },
  ),
  split: op(
    "split",
    (data: SpecData) => ({ by: data.by, subIssues: decided(data).subIssues }),
    { to: "split-opened" },
  ),
  "stop-no-work": op(
    "post",
    (data: SpecData) => {
      const { issue: number, by } = data;
      const body = decided(data).spec;
      return { comments: [{ number, by, body, key: NO_WORK_KEY }] };
    },
    { to: "no-work" },
  ),
  "publish-spec": check(
    "publish-spec",
    (data: SpecData) => ({
      by: data.by,
      spec: data.spec,
      wikiOnly: data.wikiOnly,
      interfaces: data.interfaces,
      noTestsReason: data.noTestsReason,
    }),
    {
      code: { to: "open-pr", apply: published },
      "wiki-only": { to: "close-old-pr", apply: published },
    },
  ),
  "open-pr": op(
    "start-pr",
    (data: SpecData) => ({
      body: prBodyOf(data.issue, data.settings.cfg.repo, data.spec ?? ""),
    }),
    { to: "pr-opened", apply: prOpened },
  ),
  "close-old-pr": check("close-old-pr", (data: SpecData) => ({ by: data.by }), {
    ok: { to: "wiki-only" },
  }),
};

const TABLE: Table<SpecState, SpecResult, SpecData> = {
  entries: ["claim", "open-pr", "close-old-pr"],
  states: {
    ...SCRIPT_STATES,
    session: {
      kind: "session",
      effect: session,
      on: {
        replied: { to: "check-reply", apply: read },
        failed: { to: "retry", apply: failed },
      },
    },
    ...END_STATES,
  },
};

const transition: (
  state: MachineState<SpecState, SpecData>,
  result: Result<SpecResult>,
) => Step<SpecState, SpecData> = transitionOf(TABLE, LIMITS);

const specWriterMachine: Machine<SpecState, SpecResult, SpecData> = {
  table: TABLE,
  limits: LIMITS,
  limitsOf: (cfg: SweepConfig): Limits => ({
    specContinuations: cfg.maxContinuations,
  }),
  locate,
  handoff: [
    "spec",
    "specFile",
    "wikiOnly",
    "interfaces",
    "specTestsSha",
    "noTestsReason",
    "specWritesTests",
    "pr",
    "headSha",
    "implemented",
  ],
  checkpoints: ["startSha", "startWikiSha", "attempts", "continuations"],
};

export type { SpecResult };
export { LIMITS, specWriterMachine, TABLE, transition };
