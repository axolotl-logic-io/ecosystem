// @ts-check
// The merge role through a fake RoleContext: a merge only of the exact
// authorized revision (the hardened one, or the Reviewer's own integration
// of it), read fresh right before it, with the merge queue and the head
// match passed to the merge op; its receipt saved and GitHub's confirmation
// read before the security review of the merged result; and changed inputs
// to the author, a changed head to review, before or after the merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  callNames,
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  cfg,
  current,
  gherkinComment,
  HEAD,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  PR,
  REVISION,
  SHORT_SHA_LENGTH,
  sha,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  QUEUE,
} from "./merge-role-test-kit.mjs";

const UNREADABLE_REPLY = /reply is not what the role reads/u;
const OLDER = { ...REVISION, code: sha("8") };
const SECURITY_TASK = /Task: `security-review`/u;
// Behaviour is the prompt page's, never the task's.
const BEHAVIOUR_WORDS =
  /AGENTS\.md|artificial load|allow-listed|first parent/iu;

test("a hardened revision receives Security clearance before its exact head merges and the issue completes", async () => {
  const { ctx, calls } = merging();
  const state = stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(mutationsOf(calls), ["merge", "finish"]);
  assert.equal(sessionsOf(calls).length, 1);
  assert.ok(sessionsOf(calls).every((session) => session.commits === false));
  const beforeMerge = calls.slice(0, callNames(calls).indexOf("merge"));
  assert.deepEqual(firstPayload(beforeMerge, "ci-status"), {
    pr: PR,
    expectedSha: HEAD,
  });
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, MERGED_REVISION);
  const { expectedSha, revision, mergeQueue } = firstPayload(calls, "merge");
  assert.equal(expectedSha, HEAD);
  assert.deepEqual(revision, REVISION);
  assert.deepEqual(mergeQueue, QUEUE);
  assert.ok(freshBefore(calls, "merge"));
  assert.ok(
    callNames(calls).indexOf("session") < callNames(calls).indexOf("merge"),
  );
  assert.deepEqual(state.security?.revision, REVISION);
});

test("the security review is a fresh read-only Reviewer session over the exact candidate", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  assert.deepEqual(firstPayload(calls, "prepare-review"), {
    tag: `security-${HEAD.slice(0, SHORT_SHA_LENGTH)}`,
    sinceSha: null,
    codeMerged: null,
  });
  const [spec] = sessionsOf(calls);
  assert.equal(spec?.agent, "issue-pipeline-reviewer");
  assert.equal(spec?.model, cfg.models.reviewer);
  assert.equal(spec?.commits, false);
  assert.equal(spec?.phase, "security-review");
  const task = spec?.task ?? "";
  assert.match(task, SECURITY_TASK);
  assert.ok(task.includes(MERGE_COMMIT));
  assert.ok(task.includes("/run/security/bundle.md"));
  assert.doesNotMatch(task, BEHAVIOUR_WORDS);
  const [post] = postsOf(calls);
  assert.equal(post?.on, "pr");
  assert.equal(savesOf(calls).at(-1)?.security?.finding, null);
});

test("the security comment keeps the key a pipeline with a wiki gave the same merged code, so a comment posted before the upgrade is edited, not repeated", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  const [post] = postsOf(calls);
  const merged = HEAD.slice(0, SHORT_SHA_LENGTH);
  assert.equal(post?.key, `security-${merged}-none`);
});

test("nothing integrates or pushes after Security prepares the candidate", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  const names = opNames(calls);
  const after = names.slice(names.indexOf("prepare-review"));
  for (const name of ["sync-base", "push"]) {
    assert.ok(!after.includes(name), `ran ${name} after prepare-review`);
  }
});

test("the Reviewer's own integration requires fresh hardening before merge", async () => {
  const { ctx, calls } = merging({
    state: {
      hardened: OLDER,
      integration: { reviewed: OLDER, revision: REVISION },
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.equal(state.hardened, null);
  assert.deepEqual(mutationsOf(calls), []);
  assert.equal(sessionsOf(calls).length, 0);
});

test("no authorization for the current revision goes to review without a mutation", async () => {
  const authorizations = [
    { hardened: null },
    { hardened: OLDER },
    { hardened: { ...REVISION, wiki: MOVED } },
    {
      hardened: OLDER,
      integration: { reviewed: { ...OLDER, wiki: MOVED }, revision: REVISION },
    },
  ];
  const runs = authorizations.map((state) => merging({ state }));
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    const state = stateOf(end, "next");
    assert.equal(state.stage, "review");
    assert.equal(state.hardened, null);
    assert.deepEqual(state.integration, runs[index]?.ctx.state.integration);
    assert.deepEqual(opNames(runs[index]?.calls ?? []), ["current-revision"]);
  }
});

test("inputs the Gherkin predates go to the author before anything merges", async () => {
  const { ctx, calls } = merging({
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.deepEqual(mutationsOf(calls), []);
});

test("inputs that change after the checks hold the merge back", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ inputs: NEW_INPUTS })] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.deepEqual(mutationsOf(calls), []);
});

test("a head that changes after the checks goes to review, not to merge", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ code: MOVED })] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.stage, "merge");
  assert.equal(state.security, null);
  assert.ok(!opNames(calls).includes("merge"));
});

test("a queued merge waits at merge, completing nothing", async () => {
  const { ctx, calls } = merging({
    ops: { merge: [{ merged: false, reason: "queued", waitingFor: QUEUE[0] }] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.stage, "merge");
  assert.deepEqual(mutationsOf(calls), ["merge"]);
});

test("a PR still a draft is marked ready from the saved authorization, then waits for the next merge job", async () => {
  const { ctx, calls } = merging({
    ops: {
      merge: [{ merged: false, reason: "draft" }],
      "ready-pr": [{ pr: PR, ready: true }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.stage, "merge");
  const names = callNames(calls);
  assert.ok(names.indexOf("save") < names.indexOf("ready-pr"));
  const { state: readied } = firstPayload(calls, "ready-pr");
  assert.deepEqual(readied, savesOf(calls)[0]);
  assert.equal(sessionsOf(calls).length, 1);
});

test("GitHub's refusal stops with merge-refused; a merged reply with no merge commit is an error", async () => {
  const refused = merging({
    ops: { merge: [{ merged: false, reason: "merge refused: protected" }] },
  });
  assert.equal(endCode(await mergeRole(refused.ctx)), "merge-refused");
  const blind = merging({ ops: { merge: [{ merged: true, byHand: true }] } });
  await assert.rejects(mergeRole(blind.ctx), {
    name: "OpsFailure",
    op: "merge",
    message: UNREADABLE_REPLY,
  });
  assert.ok(!opNames(blind.calls).includes("finish"));
  assert.equal(savesOf(blind.calls).length, 1);
  assert.equal(savesOf(blind.calls)[0]?.merged, null);
});

test("a merge of another head than the authorized one is never reviewed or completed as authorized", async () => {
  const { ctx, calls } = merging({
    ops: { merge: [{ ...MERGED, headSha: MOVED }] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.ok(!opNames(calls).includes("finish"));
  assert.equal(sessionsOf(calls).length, 1);
});

test("after its own merge, GitHub must confirm the merge commit before completion", async () => {
  const afters = [
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, mergeCommit: MOVED }),
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, state: "OPEN" }),
    current({ code: MOVED }, MERGED_PR),
    current({}, MERGED_PR),
  ];
  const runs = afters.map((after) =>
    merging({
      ops: { "current-revision": [current(), current(), current(), after] },
    }),
  );
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    assert.equal(endCode(end), "error");
    assert.ok(end.kind === "stop");
    assert.deepEqual(end.state.merged, MERGED_REVISION);
    const names = opNames(runs[index]?.calls ?? []);
    for (const name of ["finish"]) {
      assert.ok(!names.includes(name), `ran ${name}`);
    }
    assert.equal(sessionsOf(runs[index]?.calls ?? []).length, 1);
  }
});
