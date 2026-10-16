// @ts-check
// The fix round's step machine (src/workflow/stages/fix.ts and rereview.ts),
// driven directly with recorded results and a fixed clock. The trace tests run
// it through the sweep; these pin its prompts, comments and each outcome.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findingLines, findingsText } from "../src/workflow/findings.ts";
import {
  FIX_SCHEMA,
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
} from "../src/workflow/review-schemas.ts";
import { next } from "../src/workflow/stages/fix.ts";
import { opsRequests, sessions } from "./stage-outcome-test-kit.mjs";
import {
  DIFF_PATH,
  F1,
  FIXED,
  fixState,
  HEAD,
  REJECTED_PUSH,
  round,
  saved,
  verdict,
} from "./workflow-fix-test-kit.mjs";
import {
  CTX,
  failed,
  fixTask,
  OFF_BY_ONE,
  openFinding,
  opReply,
  replied,
  rereviewTask,
  STAMP,
  signatureOf,
} from "./workflow-review-test-kit.mjs";

/** @import { Launch, Step } from "../src/workflow/stages/types.ts" */
const FIXER_TOKENS = 100_000;
const REREVIEWER_TOKENS = 40_000;
const EVIDENCE_LIMIT = 600;
const DISPUTES =
  /\n\nDisputed:\n- \*\*f1\*\*: x+\n- \*\*f1\*\*: Again\.\n- \*\*f2\*\*: Twice\.$/u;
const RECURS =
  /\*\*Findings that came back after being resolved\*\*\n\n- was f0: `src\/a.ts:3` Back again/u;

// Round 1 of a finding the re-reviewer resolves.
const GIVEN = fixState();
const ROUND_ONE = round(GIVEN);

/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

// A round of the default finding, fixed, whose re-reviewer replies `output`.
/** @param {unknown} output @returns {ReturnType<typeof round>} */
function rereviewed(output) {
  const rereview = replied("rereview-correctness-r1", output);
  return round(fixState(), FIXED, { "rereview-correctness-r1": rereview });
}

describe("a finding fixed in round 1", () => {
  test("counts the round and launches the fixer as a writer", () => {
    assert.equal(ROUND_ONE.begun.state.st.round, 1);
    assert.equal(ROUND_ONE.begun.state.st.allocated, FIXER_TOKENS);
    assert.deepEqual(sessions(ROUND_ONE.begun), [
      {
        agent: "issue-pipeline-writer",
        model: CTX.models.fixer,
        schema: FIX_SCHEMA,
        task: fixTask(1, [F1]),
      },
    ]);
  });

  test("posts the fixer's comment, pushes, then prepares the diff since the review", () => {
    assert.deepEqual(ROUND_ONE.fixed.comments, [
      {
        by: { ...signatureOf("fix-r1"), role: "fixer (round 1)" },
        body: "Fixed the loop bound.\n\nFixed: f1",
        where: "pr",
      },
    ]);
    assert.equal(
      ROUND_ONE.fixed.state.st.log?.at(-1),
      `${STAMP} fix round 1: Fixed the loop bound.`,
    );
    assert.deepEqual(opsRequests(ROUND_ONE.fixed), [
      { op: "push", payload: { number: 7 } },
    ]);
    assert.equal(ROUND_ONE.pushed.state.st.headSha, HEAD);
    assert.deepEqual(opsRequests(ROUND_ONE.pushed), [
      {
        op: "prepare-review",
        payload: { number: 7, sinceSha: "bbbbbbb", tag: "r1" },
      },
    ]);
  });
});

describe("the re-review of a fixed finding", () => {
  test("re-reviews the lens with open findings", () => {
    assert.equal(
      ROUND_ONE.prepared.state.st.allocated,
      FIXER_TOKENS + REREVIEWER_TOKENS,
    );
    assert.deepEqual(sessions(ROUND_ONE.prepared), [
      {
        agent: "issue-pipeline-reader",
        model: CTX.models.correctness,
        schema: REREVIEW_SCHEMA,
        task: rereviewTask("correctness", DIFF_PATH, [F1]),
      },
    ]);
  });

  test("resolves the finding, moves to sync, saves, then is done", () => {
    const { st } = ROUND_ONE.settled.state;
    assert.deepEqual(st.findings, [{ ...F1, status: "resolved" }]);
    assert.deepEqual(st.resolvedHistory, ["f1: Off by one"]);
    assert.equal(st.reviewedSha, HEAD);
    assert.equal(st.stage, "sync");
    assert.equal(st.log?.at(-1), `${STAMP} fix round 1: all findings resolved`);
    assert.deepEqual(ROUND_ONE.settled.comments, [
      {
        by: {
          ...signatureOf("rereview-correctness-r1"),
          role: "re-reviewer (correctness, round 1)",
        },
        body: "Re-review of the fix in ccccccc.\n\n- **f1**: resolved — Checked.",
        where: "pr",
      },
    ]);
    assert.deepEqual(opsRequests(ROUND_ONE.settled), [
      { op: "save-state", payload: { number: 7, state: st } },
    ]);
    const done = saved(ROUND_ONE.settled);
    assert.ok(done.done);
    assert.deepEqual([done.done, done.again], [true, false]);
    assert.deepEqual(GIVEN, fixState());
  });
});

test("a finding still open after the round ends with an again step at fix", () => {
  const { settled } = rereviewed(verdict("f1", "unresolved"));
  assert.equal(settled.state.st.stage, "fix");
  const again = saved(settled);
  assert.ok(again.done);
  assert.deepEqual([again.done, again.again, again.stop], [true, true, null]);
});

test("a re-reviewer's new finding joins the open ones and keeps the issue at fix", () => {
  const loop = { ...OFF_BY_ONE, title: "New loop bug", recursId: "" };
  const { settled } = rereviewed(verdict("f1", "resolved", [loop]));
  const { st } = settled.state;
  const f2 = openFinding("f2", ["correctness"], { title: "New loop bug" });
  assert.deepEqual(st.findings, [{ ...F1, status: "resolved" }, f2]);
  assert.equal(st.nextFindingId, 2);
  assert.equal(st.stage, "fix");
  assert.equal(
    settled.comments[0]?.body,
    `Re-review of the fix in ccccccc.\n\n- **f1**: resolved — Checked.\n\n**New blocking findings the fix introduced**\n\n${findingLines([f2])}`,
  );
  const again = saved(settled);
  assert.ok(again.done);
  assert.deepEqual([again.done, again.again, again.stop], [true, true, null]);
});

describe("a finding that persists past maxFixRounds", () => {
  test("stops with no launch", () => {
    const step = next(fixState([F1], { round: 2 }), CTX, []);
    assert.equal(step.done, true);
    assert.deepEqual(step.stop, {
      reason: "blocking findings remain after 2 fix rounds",
      detail: findingsText([F1]),
      code: null,
    });
  });

  test("names an open security finding's category", () => {
    const harm = openFinding("f1", ["security"], { category: "user-harm" });
    const step = next(fixState([harm], { round: 2 }), CTX, []);
    assert.deepEqual(step.stop, {
      reason:
        "security review (user-harm): Off by one is still open after 2 fix rounds",
      detail: findingsText([harm]),
      code: "user-harm",
    });
  });
});

test("a dispute is recorded once, clipped", () => {
  const earlier = openFinding("f2", ["correctness"], {
    disputed: true,
    dispute: "Earlier.",
  });
  const evidence = "x".repeat(EVIDENCE_LIMIT + 1);
  const fix = {
    fixed: [],
    disputed: [
      { id: "f1", evidence },
      { id: "f1", evidence: "Again." },
      { id: "f2", evidence: "Twice." },
    ],
    summary: "Disputed.",
  };
  const { begun, fixed } = round(fixState([F1, earlier]), fix);
  const [fixer] = launchesOf(begun);
  assert.ok(fixer.kind === "child");
  assert.equal(fixer.task, fixTask(1, [F1, earlier], "f2"));
  const [f1, f2] = fixed.state.st.findings;
  assert.ok(f1);
  assert.deepEqual(
    [f1.disputed, f1.dispute],
    [true, `${"x".repeat(EVIDENCE_LIMIT)}…`],
  );
  assert.deepEqual(f2, earlier);
  assert.match(fixed.comments[0]?.body ?? "", DISPUTES);
});

test("a recurring finding stops the issue, with its lens's comment", () => {
  const back = { ...OFF_BY_ONE, title: "Back again", recursId: "f0" };
  const { settled } = rereviewed({ results: [], newFindings: [back] });
  assert.deepEqual(settled.stop, {
    reason: "a fix reintroduced finding f0; fixes are undoing each other",
    detail: "Back again\nThe loop stops one item early.",
    code: null,
  });
  assert.equal(settled.comments.length, 1);
  assert.match(settled.comments[0]?.body ?? "", RECURS);
});

test("a security round tags its diff and re-reviews with the security schema", () => {
  const harm = openFinding("f1", ["security"], { category: "user-harm" });
  const { pushed, prepared } = round(fixState([harm], { securityRounds: 1 }));
  const [prepare] = opsRequests(pushed);
  assert.ok(prepare);
  const { tag } = prepare.payload;
  assert.equal(tag, "s1-r1");
  const [rereview] = sessions(prepared);
  assert.equal(rereview?.schema, REREVIEW_SEC_SCHEMA);
});

test("no lens with open findings means no re-review launch", () => {
  const { prepared } = round(fixState([openFinding("f1", ["style"])]));
  assert.equal(launchesOf(prepared).length, 1);
  const [save] = launchesOf(prepared);
  assert.ok(save.kind === "op");
  assert.equal(save.op, "save-state");
  assert.equal(prepared.state.st.reviewedSha, HEAD);
  assert.equal(prepared.state.st.stage, "fix");
});

test("each failure in the round stops with its reason", () => {
  const { begun, fixed, pushed, prepared } = round(fixState());
  assert.equal(
    next(begun.state, CTX, [failed("fix-r1", "timed out")]).stop?.reason,
    "the fixer session failed",
  );
  const refused = opReply({ ok: false, error: "refused" });
  assert.equal(
    next(fixed.state, CTX, [REJECTED_PUSH]).stop?.reason,
    "could not push the fix",
  );
  assert.equal(
    next(pushed.state, CTX, [refused]).stop?.reason,
    "could not prepare the re-review diff",
  );
  const lost = failed("rereview-correctness-r1", "lost");
  assert.deepEqual(next(prepared.state, CTX, [lost]).stop, {
    reason: "a re-reviewer failed",
    detail: "lost",
    code: null,
  });
});
