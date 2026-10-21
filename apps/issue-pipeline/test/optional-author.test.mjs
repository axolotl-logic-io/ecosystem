// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeContext } from "./implementor-test-kit.mjs";
import { merging, mutationsOf } from "./merge-role-test-kit.mjs";
import {
  INPUTS,
  issueState,
  mergeRole,
  NEW_INPUTS,
  reviewerRole,
} from "./reviewer-and-merge-role-kit.mjs";
import { hardening } from "./reviewer-role-test-kit.mjs";

const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { ISSUE_STATE, newIssueState, resumeOf } = await import(
  "../src/state.ts"
);
const { requirementsHold, requirementsStage } = await import(
  "../src/requirements.ts"
);

const ISSUE = 7;
const DIRECT = { authorUsed: false, requirementsInputs: INPUTS, gherkin: null };

test("new work starts directly at Developer; explicit Author remains available", () => {
  const direct = newIssueState(ISSUE);
  assert.equal(direct.stage, "implement");
  assert.equal(requirementsStage(direct), "implement");
  assert.equal(direct.authorUsed, false);
  assert.equal(newIssueState(ISSUE, "author").authorUsed, true);
});

test("saved authored and stopped runs retain their requirements mode and provenance", () => {
  const {
    authorUsed: _mode,
    requirementsInputs: _inputs,
    ...old
  } = issueState({
    stage: "stopped",
    stoppedStage: "merge",
    resumeStage: "review",
  });
  const parsed = ISSUE_STATE.parse(old);
  assert.equal(parsed.authorUsed, true);
  assert.equal(requirementsStage(parsed), "author");
  assert.equal(requirementsHold(parsed, null, INPUTS), false);
  const resumed = resumeOf(parsed);
  assert.equal(resumed.stage, "merge");
  assert.equal(resumed.resumeStage, "review");
  assert.equal(resumed.pr, old.pr);
  assert.equal(resumed.headSha, old.headSha);
});

test("direct Developer work consumes trusted issue inputs without a Gherkin comment", async () => {
  const { ctx, sessions } = fakeContext({ state: DIRECT, gherkin: null });
  const end = await implementorRole(ctx);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.commits, true);
  assert.ok(end.kind === "next");
  assert.equal(end.state.stage, "review");
  assert.equal(end.state.authorUsed, false);
  assert.equal(end.state.requirementsInputs, ctx.inputs.revision);
  assert.equal(end.state.gherkin, null);
});

test("direct Review and Merge proceed without Gherkin, retaining ordinary checks and read-only Security", async () => {
  const review = hardening({ state: DIRECT, gherkin: null });
  const reviewed = await reviewerRole(review.ctx);
  assert.ok(reviewed.kind === "next");
  assert.equal(reviewed.state.stage, "merge");
  assert.ok(reviewed.state.hardened);
  const merge = merging({ state: DIRECT, gherkin: null });
  const merged = await mergeRole(merge.ctx);
  assert.ok(merged.kind === "next");
  assert.equal(merged.state.stage, "done");
  assert.ok(merged.state.security);
  assert.ok(mutationsOf(merge.calls).includes("merge"));
  assert.equal(
    merge.calls.filter((call) => call.kind === "session" && call.spec.commits)
      .length,
    0,
  );
});

for (const authored of [false, true]) {
  test(`changed inputs route author-used=${authored} before hardening or merge`, async () => {
    const state = {
      ...DIRECT,
      authorUsed: authored,
      requirementsInputs: NEW_INPUTS,
    };
    await Promise.all(
      [
        hardening({ state, gherkin: null }),
        merging({ state, gherkin: null }),
      ].map(async (run) => {
        let end;
        if (run.ctx.stage === "review") {
          end = await reviewerRole(run.ctx);
        } else {
          end = await mergeRole(run.ctx);
        }
        assert.ok(end.kind === "next");
        assert.equal(end.state.stage, requirementsStage(run.ctx.state));
        assert.equal(end.state.pr, run.ctx.state.pr);
        assert.equal(end.state.headSha, run.ctx.state.headSha);
        assert.equal(end.state.hardened, null);
        assert.equal(
          run.calls.filter((call) => call.kind === "session").length,
          0,
        );
        assert.deepEqual(mutationsOf(run.calls), []);
      }),
    );
  });
}

test("unanswered direct requirements stop rather than invent a requirement or invoke Author", async () => {
  const { ctx } = fakeContext({
    state: DIRECT,
    gherkin: null,
    sessions: [
      {
        ok: true,
        reply: { outcome: "cannot", reason: "Which permission should apply?" },
      },
    ],
  });
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "not-doable");
  assert.equal(end.state.authorUsed, false);
  assert.equal(end.state.stage, "implement");
});
