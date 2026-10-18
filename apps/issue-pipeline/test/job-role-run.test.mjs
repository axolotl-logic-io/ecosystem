// @ts-check
// The role runner (src/job/role-run.ts) on a controlled fake op runner and
// fake roles: the
// claim's issue file is read at the reply's top level; an issue at another
// stage is released untouched, except a done issue with its merge recorded,
// which a merge job runs its role on to reconcile the completion; a failed
// op's own error alone decides between deferring and stopping; a role's
// comment is signed with its role and agent only; and the claim hands the
// exit push the run's last saved state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const tmp = isolatedRoot;
const fakeGh = installFakeGh();
fakeGh.reply([
  { when: "api repos/o/r/collaborators/alice", keep: true },
  {
    when: "",
    code: 1,
    stderr: "unexpected role-run fake gh request",
    keep: true,
  },
]);
const { ROOT } = await import("../src/pipeline-root.ts");
const { runRoleStage } = await import("../src/job/role-run.ts");
const { stateAt, ISSUE } = await import("./job-fixtures.mjs");

const ISSUE_FILE = "/w/runs/o__r/issue-7/issue.md";
const MERGED = { code: "c0ffee", wiki: null, inputs: "in-1" };
const CODE_MERGED = { pr: 42, sha: "c0ffee" };
const NETWORK = "Could not resolve host: api.github.com";
const NAMES_ISSUE_FILE = /issueFile/u;
const SCHEMA_STOP = /the verify op failed: verify: number must be/u;
// The ids the fake post op returns, in its comments' order.
const FIRST_ID = 9;
const SECOND_ID = 10;
const CFG = {
  repo: "o/r",
  slug: "o__r",
  account: "bot",
  allowedUsers: ["alice"],
  models: { author: "m-a", implementor: "m-i", reviewer: "m-r" },
};

/**
 * @typedef {{ op: string, payload: any }} OpCall
 * @typedef {{ ok: true, reply: Record<string, unknown> } | { ok: false, error: string }} Reply
 */

/**
 * A fake op runner answering from `replies` by op, logging every call.
 * @param {Record<string, Reply>} replies
 */
function fakeOps(replies) {
  /** @type {OpCall[]} */
  const calls = [];
  /** @param {string} op @param {object} payload @returns {Promise<Reply>} */
  function runOp(op, payload) {
    calls.push({ op, payload });
    return Promise.resolve(replies[op] ?? { ok: true, reply: {} });
  }
  return { calls, runOp };
}

/** @param {Record<string, unknown>} state @returns {Reply} */
function won(state) {
  return {
    ok: true,
    reply: {
      state,
      claim: { id: 1, posted: true },
      remoteHead: null,
      issueFile: ISSUE_FILE,
      issue: ISSUE,
      comments: [],
    },
  };
}

/**
 * Runs `role` as a `stage` job on the fake ops `replies`.
 * @param {string} stage
 * @param {any} role
 * @param {Record<string, Reply>} replies
 */
async function run(stage, role, replies) {
  const { calls, runOp } = fakeOps(replies);
  /** @type {(() => any) | null} */
  let claimed = null;
  const job = {
    role,
    cfg: CFG,
    issue: 7,
    stage,
    mergeQueue: null,
    dirs: { root: tmp, repo: tmp, docs: null },
    identity: { id: randomUUID(), startedAt: new Date().toISOString() },
    hooks: {},
    status: { moved: () => undefined, settled: () => undefined },
    control: { stopping: () => null },
    runOp,
    onClaimed: (/** @type {() => any} */ last) => {
      claimed = last;
    },
  };
  // @ts-expect-error: the fake job holds only what the runner reads.
  const end = await runRoleStage(job);
  return { end, calls, claimed: () => claimed?.() ?? null };
}

/** @param {OpCall[]} calls @param {string} op */
function payloadsOf(calls, op) {
  return calls.filter((call) => call.op === op).map((call) => call.payload);
}

/** @param {any} state @returns {any} a role ending at `state`'s next */
function nextRole(state) {
  /** @type {any[]} */
  const seen = [];
  /** @param {any} ctx */
  function role(ctx) {
    seen.push(ctx);
    return Promise.resolve({ kind: "next", state });
  }
  return { role, seen };
}

test("the runner's pipeline root is a temporary one", () => {
  assert.equal(ROOT, isolatedRoot);
});

test("the role sees the claim's top-level issue file", async () => {
  const state = stateAt("author");
  const { role, seen } = nextRole({ ...state, stage: "implement" });
  const { end } = await run("author", role, { claim: won(state) });
  assert.equal(end.kind, "finished");
  assert.equal(seen[0].issueFile, ISSUE_FILE);
});

test("a claim reply with the issue file only under paths doesn't parse", async () => {
  const state = stateAt("author");
  const { role, seen } = nextRole(state);
  const reply = won(state);
  assert.ok(reply.ok);
  const { issueFile: _top, ...rest } = reply.reply;
  const { end } = await run("author", role, {
    claim: { ok: true, reply: { ...rest, paths: { issueFile: ISSUE_FILE } } },
  });
  assert.ok(end.kind === "finished");
  assert.equal(end.summary.end, "unclaimed");
  assert.match(end.summary.claimError ?? "", NAMES_ISSUE_FILE);
  assert.equal(seen.length, 0);
});

test("a merge job runs its role on a done issue with its merge recorded", async () => {
  const done = stateAt("done", { merged: MERGED, codeMerged: CODE_MERGED });
  const { role, seen } = nextRole(done);
  const { end, calls } = await run("merge", role, { claim: won(done) });
  assert.equal(seen.length, 1);
  assert.ok(end.kind === "finished");
  assert.equal(end.summary.end, "next");
  const [release] = payloadsOf(calls, "release");
  assert.deepEqual(release, { state: { ...done, lease: null } });
});

test("a done issue with no merge recorded, or at another job's stage, is released untouched", async () => {
  const cases = [
    { stage: "merge", state: stateAt("done") },
    { stage: "author", state: stateAt("done", { merged: MERGED }) },
    { stage: "merge", state: stateAt("review") },
  ];
  const runs = await Promise.all(
    cases.map(async ({ stage, state }) => {
      const { role, seen } = nextRole(state);
      return {
        state,
        seen,
        ...(await run(stage, role, { claim: won(state) })),
      };
    }),
  );
  for (const { state, seen, end, calls } of runs) {
    assert.equal(seen.length, 0, state.stage);
    assert.ok(end.kind === "finished");
    assert.equal(end.summary.end, "unclaimed");
    /** @type {Record<string, unknown>} */
    let released = state;
    if (state.stage === "done") {
      released = { ...state, lease: null };
    }
    assert.deepEqual(payloadsOf(calls, "release"), [{ state: released }]);
  }
});

/** @param {any} ctx */
async function verifyingRole(ctx) {
  await ctx.op("verify", {});
  return { kind: "next", state: ctx.state };
}

/** @param {string} error @returns {any} a role whose verify op fails with `error` */
function failingVerify(error) {
  return {
    replies: { verify: { ok: false, error } },
    role: verifyingRole,
  };
}

test("an op that fails on the network defers and releases the last saved state", async () => {
  const state = stateAt("author");
  const { replies, role } = failingVerify(NETWORK);
  const { end, calls } = await run("author", role, {
    ...replies,
    claim: won(state),
  });
  assert.ok(end.kind === "finished");
  assert.equal(end.summary.end, "deferred");
  assert.deepEqual(payloadsOf(calls, "release"), [{ state }]);
  assert.deepEqual(payloadsOf(calls, "stop"), []);
});

test("an op that fails on its schema or another error stops the issue as an error", async () => {
  const state = stateAt("author");
  const { replies, role } = failingVerify("verify: number must be a number");
  const { end, calls } = await run("author", role, {
    ...replies,
    claim: won(state),
  });
  assert.ok(end.kind === "finished");
  assert.equal(end.summary.end, "stop");
  const [stop] = payloadsOf(calls, "stop");
  assert.equal(stop.code, "error");
  assert.match(stop.reason, SCHEMA_STOP);
  assert.deepEqual(payloadsOf(calls, "release"), []);
});

test("a post on the PR before there is one stops the issue as an error, posting nothing", async () => {
  const state = stateAt("author");
  /** @param {any} ctx */
  async function role(ctx) {
    await ctx.post({ key: "k", on: "pr", role: "author", body: "b" });
    return { kind: "next", state: ctx.state };
  }
  const { end, calls } = await run("author", role, { claim: won(state) });
  assert.ok(end.kind === "finished");
  assert.equal(end.summary.end, "stop");
  assert.deepEqual(payloadsOf(calls, "post"), []);
});

test("a role's comment is signed with its role and agent, and returns the first id", async () => {
  const state = stateAt("review", { pr: 42 });
  /** @type {number[]} */
  const ids = [];
  /** @param {any} ctx */
  async function role(ctx) {
    const comment = { key: "review-1", on: "pr", role: "reviewer", body: "b" };
    ids.push(await ctx.post(comment));
    return { kind: "next", state: ctx.state };
  }
  const { calls } = await run("review", role, {
    claim: won(state),
    post: { ok: true, reply: { commentIds: [FIRST_ID, SECOND_ID] } },
  });
  assert.deepEqual(ids, [FIRST_ID]);
  assert.deepEqual(payloadsOf(calls, "post"), [
    {
      comments: [
        {
          number: 42,
          key: "review-1",
          body: "b",
          by: {
            role: "reviewer",
            agent: "issue-pipeline-reviewer",
            model: null,
            run: null,
          },
        },
      ],
    },
  ]);
});

test("the claim hands the exit push the run's last saved state", async () => {
  const state = stateAt("author");
  const saved = { ...state, log: ["checkpoint"] };
  /** @param {any} ctx */
  async function role(ctx) {
    await ctx.save(saved);
    return { kind: "wait", reason: "w", state: saved };
  }
  const { claimed } = await run("author", role, { claim: won(state) });
  assert.deepEqual(claimed(), saved);
});
