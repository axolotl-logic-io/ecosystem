// A fake RoleContext for the implementor role's tests. Its ops and sessions
// answer from scripts and record every call; nothing runs git, gh or a model.
//
// Importing this kit first points HOME and ISSUE_PIPELINE_ROOT at a fresh
// temporary folder, since the pipeline's modules read the root once, on
// import. A test then imports the pipeline's modules dynamically, after this
// kit, and checks that the root they read, `ROOT`, is `TEMPORARY_ROOT`.

import type { Config } from "../../src/config.ts";
import type { GherkinComment } from "../../src/gherkin-comment.ts";
import type {
  OpName,
  RoleContext,
  SessionResult,
  SessionSpec,
} from "../../src/job/role-context.ts";
import type { IssueState } from "../../src/state.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";

const TEMPORARY_ROOT: string = isolatedRoot;
const { ROOT }: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
const { testConfig }: typeof import("../config-test-kit.ts") = await import(
  "../config-test-kit.ts"
);
const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);
const { OpsFailure }: typeof import("../../src/job/role-context.ts") =
  await import("../../src/job/role-context.ts");

interface OpCall {
  name: OpName;
  payload: Record<string, unknown>;
}
// An op's scripted replies, used in order, the last one again once they run
// out; a reply that is an Error is thrown as the op's failure.
type OpScript = Partial<Record<OpName, unknown[]>>;

const ISSUE = 7;
const PR = 12;
const SHA_LENGTH = 40;
const INPUTS_LENGTH = 64;

//  A full commit sha of one repeated hex digit.
function shaOf(digit: string): string {
  return digit.repeat(SHA_LENGTH);
}

const HEAD = shaOf("a");
const BASE = shaOf("b");
const INPUTS = "c".repeat(INPUTS_LENGTH);

const GHERKIN: GherkinComment = {
  id: 41,
  rev: 2,
  inputs: INPUTS,
  gherkin:
    "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed",
  assumptions: ["Chats are sorted newest first"],
};

// The ops of a clean run: every check passing, code pushed.
const CLEAN_OPS: OpScript = {
  "start-pr": [{ pr: PR, headSha: HEAD }],
  verify: [{ pass: true, headSha: HEAD, changedFiles: ["a.ts"], checks: [] }],
  "open-pr": [{ pr: PR, headSha: HEAD, codeChanged: true }],
  push: [{ headSha: HEAD, codeChanged: true }],
};

const DONE: SessionResult = {
  ok: true,
  reply: { outcome: "done", summary: "Lists chats" },
};

// extra: config keys over the test config
function configOf(extra: Record<string, unknown> = {}): Config {
  return testConfig({ maxCiFixes: 2, maxConflictFixes: 2, ...extra }).cfg;
}

// The fake `op`, answering from `script` over the clean run's replies, and
// the calls it records.
function scriptedOps(script: OpScript = {}): {
  op: (name: OpName, payload: object) => Promise<unknown>;
  ops: OpCall[];
} {
  const ops: OpCall[] = [];
  const replies: OpScript = { ...CLEAN_OPS, ...script };
  const used: Partial<Record<OpName, number>> = {};
  function op(name: OpName, payload: object): Promise<unknown> {
    ops.push({ name, payload: { ...payload } });
    const list = replies[name];
    if (list === undefined || list.length === 0) {
      return Promise.reject(new OpsFailure(name, 1, `unscripted op ${name}`));
    }
    const at = used[name] ?? 0;
    used[name] = at + 1;
    const reply = list[Math.min(at, list.length - 1)];
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(reply);
  }
  return { op, ops };
}

// The fake `session`, answering `results` in order and the last one again
// once they run out, and the specs it records.
function scriptedSessions(results: SessionResult[]): {
  session: (spec: SessionSpec) => Promise<SessionResult>;
  sessions: SessionSpec[];
} {
  const sessions: SessionSpec[] = [];
  function session(spec: SessionSpec): Promise<SessionResult> {
    sessions.push(spec);
    const result = results[Math.min(sessions.length - 1, results.length - 1)];
    if (result === undefined) {
      return Promise.reject(new Error("no scripted session result"));
    }
    return Promise.resolve(result);
  }
  return { session, sessions };
}

function fakeContext(
  script: {
    ops?: OpScript;
    sessions?: SessionResult[];
    state?: Partial<IssueState>;
    gherkin?: GherkinComment | null;
    config?: Record<string, unknown>;
  } = {},
): {
  ctx: RoleContext;
  ops: OpCall[];
  sessions: SessionSpec[];
  saves: IssueState[];
} {
  const { op, ops } = scriptedOps(script.ops);
  const { session, sessions } = scriptedSessions(script.sessions ?? [DONE]);
  const saves: IssueState[] = [];
  // A null Gherkin is the test's own; only a missing one defaults.
  const { gherkin = GHERKIN } = script;
  const ctx: RoleContext = {
    cfg: configOf(script.config),
    issue: ISSUE,
    stage: "implement",
    mergeQueue: null,
    state: {
      ...newIssueState(ISSUE, "author"),
      stage: "implement",
      ...script.state,
    },
    dirs: { job: "/job", repo: "/job/repo" },
    issueFile: "/job/issue.md",
    inputs: {
      issue: { title: "List chats", body: "B", user: { login: "owner" } },
      comments: [],
      revision: INPUTS,
      gherkin,
    },
    op,
    session,
    post: () => Promise.reject(new Error("the implementor posts no comment")),
    save: (state: IssueState) => {
      saves.push(state);
      return Promise.resolve();
    },
  };
  return { ctx, ops, sessions, saves };
}

function opNames(ops: OpCall[]): OpName[] {
  return ops.map((call) => call.name);
}

export {
  BASE,
  CLEAN_OPS,
  DONE,
  fakeContext,
  GHERKIN,
  HEAD,
  INPUTS,
  ISSUE,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
};
