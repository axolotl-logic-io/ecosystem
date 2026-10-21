// @ts-check
// The Reviewer's hardening (the reviewer role) through a fake RoleContext:
// one writing session in the hardening phase, the pipeline's verification,
// a push of exactly the verified head, then the hardened revision saved
// before the PR is marked ready and the issue goes to merge. A hardening
// already saved for exactly this revision goes on with no session; the
// stage never syncs, merges or reviews security.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callNames,
  endCode,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  cfg,
  current,
  fakeContext,
  HEAD,
  issueState,
  MOVED,
  PR,
  REVISION,
  reviewerRole,
  sha,
} from "./reviewer-and-merge-role-kit.mjs";
import { hardening, PUSHED } from "./reviewer-role-test-kit.mjs";

const FIXED = sha("9");
const OLDER = { ...REVISION, code: sha("8") };
const FAILING = {
  pass: false,
  headSha: HEAD,
  checks: [{ id: "test", pass: false, detail: "exit 1" }],
};
// The ops hardening never runs: syncing and merging are the merge stage's.
const MERGE_STAGE_OPS = new Set([
  "sync-base",
  "ci-status",
  "merge",
  "prepare-review",
  "finish",
]);

const HARDENING_TASK = /Task: `hardening`/u;
const BRANCH_SCOPE =
  /Scope: the code branch in `repo\/`, including its docs in `repo\/docs\/`\. The change: `git -C repo diff origin\/\S+\.\.\.HEAD`/u;
const GHERKIN = /Scenario: list/u;
// Behaviour is the prompt page's, never the task's.
const BEHAVIOUR_WORDS =
  /AGENTS\.md|pipeline_commit|artificial load|adversarial/iu;
const HARDENING_PASSED = /^## Hardening passed/u;
const NO_INVENTED_APPROVAL = /approv|security review passed/iu;
const NOT_DOABLE = /question only a person can answer: is the list paged\?/u;
const NOT_VERIFIED = /not the verified/u;
const NO_CODE = /changes no code file/u;

test("hardening runs one Reviewer session, verifies, pushes, saves the hardened revision, then readies the PR and goes to merge", async () => {
  const { ctx, calls } = hardening();
  const end = await reviewerRole(ctx);
  assert.deepEqual(callNames(calls), [
    "current-revision",
    "session",
    "verify",
    "push",
    "current-revision",
    "save",
    "post",
    "ready-pr",
  ]);
  const [spec] = sessionsOf(calls);
  assert.equal(spec?.agent, "issue-pipeline-reviewer");
  assert.equal(spec?.model, cfg.models.reviewer);
  assert.equal(spec?.phase, "hardening");
  assert.equal(spec?.commits, true);
  const [saved] = savesOf(calls);
  assert.deepEqual(saved?.hardened, REVISION);
  assert.equal(saved?.integration, null);
  assert.equal(saved?.stage, "review");
  assert.equal(saved?.verifiedSha, HEAD);
  const state = stateOf(end, "next");
  assert.equal(state.stage, "merge");
  assert.deepEqual(state.hardened, REVISION);
});

test("the hardening task carries the facts: kind, scope and Gherkin, no behaviour", async () => {
  const { ctx, calls } = hardening();
  await reviewerRole(ctx);
  const task = sessionsOf(calls)[0]?.task ?? "";
  assert.match(task, HARDENING_TASK);
  assert.match(task, BRANCH_SCOPE);
  assert.match(task, GHERKIN);
  assert.doesNotMatch(task, BEHAVIOUR_WORDS);
  assert.ok(
    task.includes(`commands.test: ${JSON.stringify(ctx.cfg.commands.test)}`),
  );
});

test("the comment says only that hardening passed, never that anything was approved", async () => {
  const { ctx, calls } = hardening();
  await reviewerRole(ctx);
  const [post] = postsOf(calls);
  assert.equal(post?.key, "hardening");
  assert.equal(post?.on, "pr");
  assert.match(post?.body ?? "", HARDENING_PASSED);
  assert.doesNotMatch(post?.body ?? "", NO_INVENTED_APPROVAL);
});

test("a hardening saved for exactly this revision goes on to merge with no session", async () => {
  const { ctx, calls } = fakeContext({
    stage: "review",
    state: issueState({ stage: "review", hardened: REVISION }),
    ops: {
      "current-revision": [current()],
      "ready-pr": [{ pr: PR, ready: true }],
    },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(state.stage, "merge");
});

test("an integrated head needs a fresh hardening session even when linked to the earlier hardening", async () => {
  const { ctx, calls } = hardening({
    state: {
      hardened: OLDER,
      integration: { reviewed: OLDER, revision: REVISION },
    },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 1);
  assert.deepEqual(state.hardened, REVISION);
  assert.equal(state.integration, null);
});

test("a hardening of an earlier revision is redone on the current one", async () => {
  const { ctx, calls } = hardening({ state: { hardened: OLDER } });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 1);
  assert.deepEqual(state.hardened, REVISION);
});

test("a ready-pr that fails leaves the hardened revision saved, so the next job only readies the PR", async () => {
  const failure = new Error("gh pr ready failed");
  const { ctx, calls } = hardening({ ops: { "ready-pr": [failure] } });
  await assert.rejects(reviewerRole(ctx));
  const names = callNames(calls);
  assert.ok(names.indexOf("save") < names.indexOf("ready-pr"));
  assert.deepEqual(savesOf(calls)[0]?.hardened, REVISION);
});

test("cannot stops not-doable with nothing verified, pushed or saved", async () => {
  const { ctx, calls } = hardening({
    sessions: [
      {
        ok: true,
        reply: { outcome: "cannot", reason: "is the list paged?" },
      },
    ],
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "not-doable");
  assert.ok(end.kind === "stop");
  assert.match(end.reason, NOT_DOABLE);
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(savesOf(calls).length, 0);
});

test("a failing check gets a hardening-phase fix session and the fixed head is the one pushed", async () => {
  const { ctx, calls } = hardening({
    after: current({ code: FIXED }),
    ops: {
      verify: [FAILING, { pass: true, headSha: FIXED, checks: [] }],
      push: [{ ...PUSHED, headSha: FIXED }],
    },
    sessions: [
      { ok: true, reply: { outcome: "done", summary: "hardened" } },
      { ok: true, reply: { outcome: "done", summary: "fixed" } },
    ],
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  const specs = sessionsOf(calls);
  assert.equal(specs.length, 2);
  assert.ok(specs.every((spec) => spec.phase === "hardening"));
  for (const spec of specs) {
    assert.ok(
      spec.task.includes(
        `commands.test: ${JSON.stringify(ctx.cfg.commands.test)}`,
      ),
    );
  }
  assert.equal(state.verifiedSha, FIXED);
  assert.equal(state.hardened?.code, FIXED);
});

test("a hardening timeout never verifies, checkpoints or readies the draft", async () => {
  const { ctx, calls } = hardening({
    sessions: [
      { ok: false, transient: false, error: "timed out before it exited" },
    ],
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "error");
  assert.deepEqual(callNames(calls), ["current-revision", "session"]);
  assert.equal(savesOf(calls).length, 0);
});

test("a targeted-test reply cannot bypass the bounded deterministic check-fix gate", async () => {
  const { ctx, calls } = hardening({
    config: {
      maxCiFixes: 1,
      commands: { test: "mise //apps/issue-pipeline:check" },
    },
    ops: { verify: [FAILING, FAILING] },
    sessions: [
      { ok: true, reply: { outcome: "done", summary: "targeted tests pass" } },
      {
        ok: true,
        reply: { outcome: "done", summary: "targeted fix tests pass" },
      },
    ],
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "check-fixes");
  assert.deepEqual(callNames(calls), [
    "current-revision",
    "session",
    "verify",
    "session",
    "verify",
  ]);
  assert.equal(savesOf(calls).length, 0);
  for (const spec of sessionsOf(calls)) {
    assert.ok(
      spec.task.includes('commands.test: "mise //apps/issue-pipeline:check"'),
    );
  }
});

test("a push of anything but the verified head stops with error and saves nothing", async () => {
  const { ctx, calls } = hardening({
    ops: { push: [{ ...PUSHED, headSha: MOVED }] },
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.match(end.reason, NOT_VERIFIED);
  assert.equal(savesOf(calls).length, 0);
  assert.ok(!opNames(calls).includes("ready-pr"));
});

test("a branch left with no code after hardening stops, never going to merge", async () => {
  const { ctx, calls } = hardening({
    ops: { push: [{ ...PUSHED, codeChanged: false }] },
  });
  const end = await reviewerRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.match(end.reason, NO_CODE);
  assert.equal(savesOf(calls).length, 0);
});

test("hardening never syncs, merges, reviews security or completes", async () => {
  const runs = [
    hardening(),
    hardening({ state: { hardened: REVISION } }),
    hardening({ after: current({ code: MOVED }) }),
  ];
  await Promise.all(runs.map(({ ctx }) => reviewerRole(ctx)));
  for (const { calls } of runs) {
    for (const name of opNames(calls)) {
      assert.ok(!MERGE_STAGE_OPS.has(name), `ran ${name}`);
    }
    for (const spec of sessionsOf(calls)) {
      assert.equal(spec.phase, "hardening");
    }
  }
});
