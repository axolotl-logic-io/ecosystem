// @ts-check
// Explicit Author retains saved direct work; real role replies decide its return.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeContext, INPUTS } from "./implementor-test-kit.mjs";

const { newIssueState, ISSUE_STATE } = await import("../src/state.ts");
const { requestedAuthorState } = await import("../src/ops/author-request.ts");
const { authorRole } = await import("../src/roles/author/author.ts");
const { requirementsStage } = await import("../src/requirements.ts");
const NOW = new Date("2026-10-21T00:00:00Z");
const REQUEST = { stage: /** @type {const} */ ("author"), now: NOW };
const ISSUE = 7;
const PR = 12;
const GHERKIN_COMMENT = 41;
const SHA_LENGTH = 40;
const CODE = "a".repeat(SHA_LENGTH);
const REVISION = { code: CODE, inputs: INPUTS };
const GHERKIN =
  "Feature: Chats\n  Scenario: list\n    Given a chat\n    Then it is listed";
const REPLY = {
  outcome: "gherkin",
  gherkin: GHERKIN,
  assumptions: [],
  changed: false,
};
const REJECTION = {
  revision: REVISION,
  commentId: 1,
  finding: { category: "abuse-risk", reason: "Unsafe" },
};
const REFUSED = /cannot switch to Author/u;

/** @param {object} [fields] */
function directState(fields = {}) {
  return ISSUE_STATE.parse({
    ...newIssueState(ISSUE),
    stage: "review",
    pr: PR,
    branch: "retained-work",
    headSha: CODE,
    requirementsInputs: INPUTS,
    hardened: REVISION,
    integration: { reviewed: REVISION, revision: REVISION },
    counts: { conflictFixes: 1, syncs: 2 },
    ...fields,
  });
}

/** @param {import('../src/state.ts').IssueState} state @param {Record<string, unknown>} [reply] @param {string} [inputs] */
function authorContext(state, reply = REPLY, inputs = INPUTS) {
  const run = fakeContext({
    state,
    gherkin: null,
    sessions: [{ ok: true, reply }],
  });
  run.ctx.stage = "author";
  run.ctx.inputs.revision = inputs;
  run.ctx.post = () => Promise.resolve(GHERKIN_COMMENT);
  return run;
}

for (const stage of /** @type {const} */ (["implement", "review", "merge"])) {
  test(`explicit Author checkpoints direct ${stage} and returns unchanged work there without new approval`, async () => {
    const saved = directState({ stage });
    const requested = requestedAuthorState(saved, REQUEST);
    assert.equal(requested.stage, "author");
    assert.equal(requested.authorUsed, true);
    assert.equal(requested.resumeStage, stage);
    assert.deepEqual(
      {
        ...requested,
        stage,
        authorUsed: false,
        resumeStage: null,
        log: saved.log,
      },
      saved,
    );
    const run = authorContext(requested);
    const end = await authorRole(run.ctx);
    assert.ok(end.kind === "next");
    assert.equal(end.state.stage, stage);
    assert.equal(end.state.resumeStage, null);
    assert.equal(end.state.gherkin?.rev, 1);
    assert.equal(end.state.headSha, CODE);
    assert.deepEqual(end.state.hardened, saved.hardened);
    assert.deepEqual(end.state.integration, saved.integration);
    assert.equal(end.state.security, null);
    assert.equal(run.sessions[0]?.commits, false);
    assert.equal(requirementsStage(end.state), "author");
  });
}

test("interrupted and asked Author passes retain the original return checkpoint without reselecting a mode", async () => {
  const requested = requestedAuthorState(directState(), REQUEST);
  assert.deepEqual(requestedAuthorState(requested, REQUEST), requested);
  const interrupted = authorContext(requested);
  interrupted.ctx.session = () =>
    Promise.resolve({ ok: false, error: "offline", transient: true });
  assert.deepEqual(await authorRole(interrupted.ctx), {
    kind: "deferred",
    error: "offline",
  });
  const asking = authorContext(requested, {
    outcome: "needs-info",
    questions: ["Which panel?"],
  });
  const end = await authorRole(asking.ctx);
  assert.ok(end.kind === "ask");
  assert.equal(end.state.resumeStage, "review");
  assert.equal(end.state.pr, PR);
  assert.equal(end.state.headSha, CODE);
  const reparsed = ISSUE_STATE.parse(JSON.parse(JSON.stringify(end.state)));
  assert.equal(requestedAuthorState(reparsed, REQUEST).resumeStage, "review");
});

for (const change of ["behavior", "trusted-inputs"]) {
  test(`a first Author pass with changed ${change} cannot reuse old approval`, async () => {
    const requested = requestedAuthorState(
      directState({
        security: { revision: REVISION, commentId: 1, finding: null },
      }),
      REQUEST,
    );
    const run = authorContext(requested, {
      ...REPLY,
      changed: change === "behavior",
    });
    if (change === "trusted-inputs") {
      run.ctx.inputs.revision = "new-inputs";
    }
    const end = await authorRole(run.ctx);
    assert.ok(end.kind === "next");
    assert.equal(end.state.stage, "implement");
    assert.equal(end.state.hardened, null);
    assert.equal(end.state.integration, null);
    assert.equal(end.state.security, null);
    assert.equal(end.state.pr, PR);
    assert.equal(end.state.headSha, CODE);
  });
}

test("explicit Author never synthesizes missing approval and never erases a saved rejection", async () => {
  const requested = requestedAuthorState(
    directState({ hardened: null, integration: null }),
    REQUEST,
  );
  const end = await authorRole(authorContext(requested).ctx);
  assert.ok(end.kind === "next");
  assert.equal(end.state.hardened, null);
  assert.equal(end.state.integration, null);
  assert.equal(end.state.security, null);
  const rejected = authorContext(
    {
      ...requested,
      security: ISSUE_STATE.parse({ ...requested, security: REJECTION })
        .security,
    },
    { ...REPLY, changed: true },
  );
  const rejectedEnd = await authorRole(rejected.ctx);
  assert.ok(rejectedEnd.kind === "next");
  assert.deepEqual(rejectedEnd.state.security, REJECTION);
});

test("a stopped direct issue retains its ordinary resume meaning and an authored issue is never reset", () => {
  const stopped = directState({
    stage: "stopped",
    stoppedStage: "review",
    stopCode: "error",
  });
  assert.equal(requestedAuthorState(stopped, REQUEST).resumeStage, "review");
  const legacy = directState({ authorUsed: true });
  assert.deepEqual(requestedAuthorState(legacy, REQUEST), legacy);
  const ordinary = directState();
  assert.deepEqual(
    requestedAuthorState(ordinary, { stage: "implement", now: NOW }),
    ordinary,
  );
});

for (const fields of [
  { stage: "done" },
  { codeMerged: { pr: PR, sha: CODE } },
  { merged: REVISION },
  { security: REJECTION },
  {
    mergeAttempt: {
      repo: "o/r",
      pr: PR,
      target: "integration",
      branch: "retained-work",
      authorized: REVISION,
      hardened: REVISION,
      integration: null,
      result: null,
      reads: 0,
    },
  },
]) {
  test(`explicit Author refuses completion/merge/rejection authority ${JSON.stringify(fields)}`, () => {
    const saved = directState(fields);
    assert.throws(() => requestedAuthorState(saved, REQUEST), REFUSED);
    assert.equal(saved.authorUsed, false);
    assert.deepEqual(saved.security, directState(fields).security);
    assert.deepEqual(saved.mergeAttempt, directState(fields).mergeAttempt);
  });
}
