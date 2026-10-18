// @ts-check
// Implement pushes a done session's commits and saves the pushed head before
// it moves the issue to open-pr (#315). The stage job's checkout is removed
// when the job exits, and the next job's claim stops an issue whose branch
// moved past its saved head, so a head saved before the push stopped every
// implemented issue as branch-changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { next } from "../src/workflow/stages/implement.ts";
import { releasedState, requestFor } from "./stage-outcome-test-kit.mjs";
import {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  IMPL_BY,
} from "./workflow-build-test-kit.mjs";
import { REJECTED_PUSH } from "./workflow-fix-test-kit.mjs";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

// The head start-pr pushed, and the head of the implementer's commits.
const START_HEAD = "7a4d711";
const PUSHED_HEAD = "7147176";
const PUSH = { kind: "op", name: "push", op: "push", payload: { number: 7 } };
const READ_FAILED = {
  ok: false,
  error: "EAGAIN: resource temporarily unavailable, read",
};
const DONE = {
  status: "done",
  summary: "Did the thing.",
  prTitle: "Do the thing",
  prBody: "Does the thing, tested in src/a.test.ts.",
  testsAdded: ["src/a.test.ts"],
};

// Implement's step once its done session has replied: the push.
/** @returns {Step} */
function pushing() {
  const begun = next(
    buildState("implement", { headSha: START_HEAD }),
    BUILD_CTX,
    [],
  );
  return afterSession(next, begun, IMPL_BY, {
    ok: true,
    structuredOutput: DONE,
  });
}

/** @param {Step} step @returns {unknown[]} */
function launchesOf(step) {
  if (step.done) {
    return [];
  }
  return [...step.launches];
}

test("a done session's commits are pushed before the issue moves on", () => {
  const step = pushing();
  assert.equal(step.done, false);
  assert.deepEqual(launchesOf(step), [PUSH]);
  assert.equal(step.state.st.stage, "implement");
  assert.equal(step.state.st.prTitle, "Do the thing");
});

test("the pushed head is saved as headSha, at open-pr", () => {
  const done = afterReply(next, pushing(), {
    ok: true,
    headSha: PUSHED_HEAD,
    codeChanged: true,
    wikiAhead: 0,
  });
  assert.equal(done.done, true);
  assert.equal(done.stop, null);
  assert.equal(done.state.st.stage, "open-pr");
  assert.equal(done.state.st.headSha, PUSHED_HEAD);
  assert.deepEqual(done.state.st.prBy, IMPL_BY);
});

test("a push that fails before git pushes is retried once, then stops", () => {
  const retry = afterReply(next, pushing(), READ_FAILED);
  assert.deepEqual(launchesOf(retry), [PUSH]);
  const pushed = afterReply(next, retry, { ok: true, headSha: PUSHED_HEAD });
  assert.equal(pushed.state.st.headSha, PUSHED_HEAD);
  assert.equal(pushed.state.st.stage, "open-pr");
  const failed = afterReply(next, retry, READ_FAILED);
  assert.equal(failed.stop?.code, "error");
});

test("a rejected push stops as push-rejected and keeps the saved head", () => {
  const stopped = afterReply(next, pushing(), REJECTED_PUSH.reply);
  assert.equal(stopped.stop?.reason, "could not push the implementation");
  assert.equal(stopFor(stopped.stop?.reason)?.code, "push-rejected");
  assert.equal(stopped.state.st.headSha, START_HEAD);
});

test("an implement job saves the pushed head, and the open-pr job's claim takes it", async () => {
  const implemented = await runWorkflow({
    args: { ...WORKFLOW_ARGS, stage: "implement" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: {
        ...claimAt("implement", {
          plan: "Change src/a.ts.",
          pr: 42,
          headSha: START_HEAD,
        }),
        remoteHead: START_HEAD,
      },
      push: { ok: true, headSha: PUSHED_HEAD, codeChanged: true },
    },
    agents: { "i7-implement": replyWith(DONE) },
  });
  const keys = implemented.trace.map(({ key }) => key);
  const pushedAt = keys.findIndex((key) => key.startsWith("i7-push"));
  const releasedAt = keys.findIndex((key) => key.startsWith("i7-release"));
  assert.ok(pushedAt !== -1 && pushedAt < releasedAt, keys.join(", "));
  const saved = releasedState(implemented.trace);
  assert.deepEqual([saved.stage, saved.headSha], ["open-pr", PUSHED_HEAD]);
  const opened = await runWorkflow({
    args: { ...WORKFLOW_ARGS, stage: "open-pr" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: { ...claimAt("open-pr", saved), remoteHead: PUSHED_HEAD },
      "open-pr": { ok: true, pr: 42, headSha: PUSHED_HEAD, codeChanged: true },
    },
    agents: {},
  });
  assert.throws(() => requestFor(opened.trace, "stop"));
  assert.deepEqual(
    opened.summary,
    sweepSummary({
      items: [
        {
          issue: ISSUE,
          pr: 42,
          stage: "review",
          outcome: "in-progress",
          reason: null,
        },
      ],
    }),
  );
});
