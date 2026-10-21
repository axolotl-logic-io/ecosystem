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
  CODE_MERGED,
  MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  QUEUE,
} from "./merge-role-test-kit.mjs";
import {
  callNames,
  checksBefore,
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
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
} from "./reviewer-and-merge-role-kit.mjs";

const UNREADABLE_REPLY = /reply is not what the role reads/u;
const OLDER = { ...REVISION, code: sha("8") };
const SECURITY_TASK = /Task: `security-review`/u;
const MERGED_CHECKOUT = new RegExp(
  `Code checkout: \`repo/\`, detached at the merge commit \`${MERGE_COMMIT}\`: the merged result`,
  "u",
);
const BUNDLE = /Bundle: `\/run\/security\/bundle\.md`/u;
// Behaviour is the wiki page's, never the task's.
const BEHAVIOUR_WORDS =
  /AGENTS\.md|artificial load|allow-listed|first parent/iu;
const SECURITY_COMMENT =
  /^## Security review of the merged result: no security finding/u;

test("a hardened revision merges with its head matched, then the security review of the merged result clears it and the issue completes", async () => {
  const { ctx, calls } = merging();
  const state = stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(mutationsOf(calls), ["merge", "finish-wiki"]);
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
  const checks = checksBefore(calls, "prepare-review");
  assert.deepEqual(checks.verify, { number: ctx.issue, ...CODE_MERGED });
});

test("the security review is a fresh read-only Reviewer session over the merge commit GitHub confirmed", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  assert.deepEqual(firstPayload(calls, "prepare-review"), {
    tag: `security-${MERGE_COMMIT.slice(0, SHORT_SHA_LENGTH)}`,
    sinceSha: null,
    codeMerged: { pr: PR, sha: MERGE_COMMIT },
  });
  const [spec] = sessionsOf(calls);
  assert.equal(spec?.agent, "issue-pipeline-reviewer");
  assert.equal(spec?.model, cfg.models.reviewer);
  assert.equal(spec?.commits, false);
  assert.equal(spec?.phase, "security-review");
  const task = spec?.task ?? "";
  assert.match(task, SECURITY_TASK);
  assert.match(task, MERGED_CHECKOUT);
  assert.match(task, BUNDLE);
  assert.doesNotMatch(task, BEHAVIOUR_WORDS);
  const [post] = postsOf(calls);
  assert.equal(post?.on, "pr");
  assert.match(post?.body ?? "", SECURITY_COMMENT);
});

test("nothing integrates or pushes once the merged result is prepared for review", async () => {
  const { ctx, calls } = merging();
  await mergeRole(ctx);
  const names = opNames(calls);
  const after = names.slice(names.indexOf("prepare-review"));
  for (const name of ["sync-base", "push", "verify", "merge"]) {
    assert.ok(!after.includes(name), `ran ${name} after prepare-review`);
  }
});

test("the Reviewer's own integration of the hardened revision authorizes the merge of the integrated one", async () => {
  const { ctx, calls } = merging({
    state: {
      hardened: OLDER,
      integration: { reviewed: OLDER, revision: REVISION },
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  const { expectedSha } = firstPayload(calls, "merge");
  assert.equal(expectedSha, HEAD);
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
    assert.equal(state.integration, null);
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
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
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
  assert.equal(sessionsOf(calls).length, 0);
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
  assert.ok(!opNames(blind.calls).includes("finish-wiki"));
  assert.equal(savesOf(blind.calls).length, 0);
});

test("a merge of another head than the authorized one is never reviewed or completed as authorized", async () => {
  const { ctx, calls } = merging({
    ops: { merge: [{ ...MERGED, headSha: MOVED }] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  for (const name of ["prepare-review", "finish-wiki"]) {
    assert.ok(!opNames(calls).includes(name), `ran ${name}`);
  }
  assert.equal(sessionsOf(calls).length, 0);
});

test("after its own merge, GitHub must confirm the merge commit before any security review", async () => {
  const afters = [
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, mergeCommit: MOVED }),
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, state: "OPEN" }),
    current({ code: MOVED }, MERGED_PR),
    current({}, MERGED_PR),
  ];
  const runs = afters.map((after) =>
    merging({ ops: { "current-revision": [current(), current(), after] } }),
  );
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    assert.equal(endCode(end), "error");
    assert.ok(end.kind === "stop");
    assert.deepEqual(end.state.merged, MERGED_REVISION);
    const names = opNames(runs[index]?.calls ?? []);
    for (const name of ["prepare-review", "finish-wiki"]) {
      assert.ok(!names.includes(name), `ran ${name}`);
    }
    assert.equal(sessionsOf(runs[index]?.calls ?? []).length, 0);
  }
});
