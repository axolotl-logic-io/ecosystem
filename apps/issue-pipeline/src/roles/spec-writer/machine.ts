// The spec writer role as a state machine (`role-state-machines`; the wiki's
// Pipeline-Roles-Spec-Writer, "Lifecycle"): its table, its limits and its
// pure transition. Only `session` runs a model. Ops answer `ok`, the session
// `replied` or `failed`, and a state that routes on what it found is a check
// that names its result. The ops and checks are carried out by the job; this
// module only names them with their payloads. The registry runs it for
// `--stage spec` (src/roles/registry.ts, #334).

import type {
  Edge,
  End,
  Guard,
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
  prOpened,
  published,
  read,
  readied,
  refusal,
  started,
  testsCommitted,
} from "./edges.ts";
import type { SpecData, SpecState } from "./locate.ts";
import { locate } from "./locate.ts";
import { prBodyOf } from "./pr.ts";
import { FAILED_TWICE, specSession } from "./task.ts";

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
  | "wiki-only";

type Spec = StateSpec<SpecState, SpecResult, SpecData>;
type Payload = Readonly<Record<string, unknown>>;

// At most 2 sessions per issue, counted across restarts.
const LIMITS: Readonly<Record<string, number>> = { specAttempts: 2 };

// The no-work stop's code (agent:stopped-no-work), and its comment's key.
const NO_WORK_CODE = "no-work";
const NO_WORK_KEY = "no-work";

const ATTEMPTS: Guard<SpecState, SpecData> = {
  field: "attempts",
  limit: "specAttempts",
  over: "failed-twice",
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

function end(endOf: (data: SpecData) => End): Spec {
  return {
    kind: "end",
    effect: (data: SpecData) => ({ kind: "end", end: endOf(data) }),
    on: {},
  };
}

function stopped(data: SpecData, reason: string): End {
  const { issue: number, checkOutput: detail } = data;
  const payload = { number, code: "error", reason, detail };
  return { kind: "stopped", code: "error", after: { op: "stop", payload } };
}

function session(data: SpecData): SessionEffect {
  const { settings } = data;
  return specSession(
    {
      n: data.issue,
      paths: settings.paths,
      depth: data.depth,
      plan: data.plan,
      splitSuggested: data.splitSuggested,
      attempt: data.attempts,
      checkOutput: data.checkOutput,
    },
    settings,
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
    },
  ),
  "check-commits": check(
    "spec-tests-check",
    (data: SpecData) => ({
      startSha: data.startSha,
      files: data.files,
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
      files: data.files,
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

const END_STATES = {
  released: end(() => ({ kind: "released" })),
  "split-opened": end(() => ({ kind: "released" })),
  asked: end(() => ({ kind: "saved", stage: "triage" })),
  "no-work": end(() => ({ kind: "stopped", code: NO_WORK_CODE })),
  "pr-opened": end(() => ({ kind: "saved", stage: "implement" })),
  "wiki-only": end(() => ({ kind: "saved", stage: "review" })),
  "failed-twice": end((data: SpecData) => stopped(data, FAILED_TWICE)),
  "split-refused": end((data: SpecData) => stopped(data, refusal(data))),
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
  locate,
  handoff: [
    "spec",
    "specFile",
    "files",
    "interfaces",
    "specTestsSha",
    "noTestsReason",
    "specWritesTests",
    "pr",
    "headSha",
    "implemented",
  ],
  checkpoints: ["startSha", "startWikiSha", "attempts"],
};

export type { SpecResult };
export { LIMITS, specWriterMachine, TABLE, transition };
