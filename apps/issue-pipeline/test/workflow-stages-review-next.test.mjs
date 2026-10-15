// @ts-check
// The review's step machine (src/workflow/stages/review.ts), driven directly
// with recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin its prompts, comments and each outcome's step.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGG_SCHEMA, REVIEW_SCHEMA } from "../src/workflow/review-schemas.ts";
import { byStep } from "../src/workflow/signing.ts";
import { next } from "../src/workflow/stages/review.ts";
import {
  aggregateTask,
  CTX,
  contextWith,
  DIFF,
  failed,
  lensTask,
  OFF_BY_ONE,
  openFinding,
  opReply,
  replied,
  SPEC_HEADING,
  STAMP,
  signatureOf,
  stateWith,
} from "./workflow-review-test-kit.mjs";

/** @import { Lens } from "../src/workflow/lenses.ts" */
/** @import { Launch, LaunchResult, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @typedef {{ findings?: unknown[], failed?: string }} LensOutput */
/** @type {Lens[]} */
const LENS_NAMES = ["correctness", "tests", "scope"];
const REVIEWERS_TOKENS = 180_000;
const AGGREGATOR_TOKENS = 20_000;
const HEAD = "ccccccc";
const PREPARED = {
  ok: true,
  headSha: HEAD,
  diffPath: DIFF.path,
  diffLines: DIFF.lines,
};
const BLOCKING = { severity: "blocking", ...OFF_BY_ONE };
const RAW = [{ lens: "correctness", ...BLOCKING }];
const IDS_COMMENT =
  "Blocking findings for the fixer, with duplicates merged. Later comments refer to these ids.\n\n- **f1** `src/a.ts:3` Off by one (raised by correctness)";
const SPEC = "## Behaviour\n\n1. The loop visits every item.";
const NIT_SECTION =
  /\*\*Non-blocking\*\* \(the pipeline won't act on these\)\n\n- `src\/a.ts:3` Name it/u;
const BLOCKING_SECTION = /\*\*Blocking\*\*\n\n- `src\/a.ts:3` Off by one/u;
// An issue budget smaller than the three reviewers.
const SMALL_BUDGET = 100_000;

// The review's step after its reviewers reply with `outputs` by lens (no
// findings for a lens not named), or with a failed result.
/** @param {Partial<Record<Lens, LensOutput>>} [outputs] @returns {Step} */
function reviewed(outputs = {}) {
  const begun = next(stateWith("review"), CTX, []);
  const started = next(begun.state, CTX, [opReply(PREPARED)]);
  const results = LENS_NAMES.map((lens) => {
    const output = outputs[lens] ?? { findings: [] };
    if (output.failed !== undefined) {
      return failed(`review-${lens}`, output.failed);
    }
    return replied(`review-${lens}`, output);
  });
  return next(started.state, CTX, results);
}

// The step after the aggregator ends with `result`, for one blocking finding.
/** @param {LaunchResult} result @returns {Step} */
function aggregated(result) {
  const step = reviewed({ correctness: { findings: [BLOCKING] } });
  return next(step.state, CTX, [result]);
}

/** @param {Step} step @returns {Launch[]} */
function saveOf(step) {
  const payload = { number: 7, state: step.state.st };
  return [{ kind: "op", name: "save", op: "save-state", payload }];
}

/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

describe("a clean review", () => {
  test("charges the reviewers and prepares the diff", () => {
    const given = stateWith("review");
    const step = next(given, CTX, []);
    assert.deepEqual(launchesOf(step), [
      {
        kind: "op",
        name: "prep",
        op: "prepare-review",
        payload: { number: 7, tag: "r0" },
      },
    ]);
    assert.equal(step.state.st.allocated, REVIEWERS_TOKENS);
    assert.deepEqual(step.state.st.sessions, ["reviewer"]);
    assert.deepEqual(given, stateWith("review"));
  });

  test("posts each lens's comment, moves to sync, saves, then is done", () => {
    const nit = { ...OFF_BY_ONE, severity: "nit", title: "Name it" };
    const step = reviewed({ tests: { findings: [nit] } });
    assert.deepEqual(
      step.comments.map(({ by }) => by),
      LENS_NAMES.map((lens) => ({
        ...signatureOf(`review-${lens}`),
        role: `reviewer (${lens})`,
      })),
    );
    assert.deepEqual(step.comments.at(0), {
      by: {
        ...signatureOf("review-correctness"),
        role: "reviewer (correctness)",
      },
      body: "Review of ccccccc for correctness.\n\nNo blocking findings.\n\n",
      where: "pr",
    });
    assert.match(step.comments.at(1)?.body ?? "", NIT_SECTION);
    assert.equal(step.state.st.stage, "sync");
    assert.equal(step.state.st.reviewedSha, HEAD);
    assert.deepEqual(step.state.st.log, [
      `${STAMP} charged reviewer 180000 to issueTokenBudget`,
      `${STAMP} review: no blocking findings`,
    ]);
    assert.deepEqual(launchesOf(step), saveOf(step));
    const done = next(step.state, CTX, [opReply({ ok: true })]);
    assert.ok(done.done);
    assert.deepEqual([done.done, done.again, done.stop], [true, false, null]);
  });
});

test("a review launches the three lenses on the prepared head", () => {
  const begun = next(stateWith("review"), CTX, []);
  const step = next(begun.state, CTX, [opReply(PREPARED)]);
  assert.deepEqual(
    launchesOf(step),
    LENS_NAMES.map((lens) => ({
      kind: "child",
      name: `review-${lens}`,
      label: `Review ${lens} of issue 7`,
      agent: "issue-pipeline-reader",
      model: CTX.models[lens],
      schema: REVIEW_SCHEMA,
      minutes: 25,
      task: lensTask(lens),
    })),
  );
  const { headSha, findings, round } = step.state.st;
  assert.deepEqual(
    { headSha, findings, round },
    { headSha: HEAD, findings: [], round: 0 },
  );
});

describe("the lenses' tasks", () => {
  // The tasks of the lenses launched on the prepared head of `given`.
  /** @param {StageState} given @returns {string[]} */
  function lensTasks(given) {
    const begun = next(given, CTX, []);
    const step = next(begun.state, CTX, [opReply(PREPARED)]);
    return launchesOf(step).map((launch) => {
      if (launch.kind !== "child") {
        throw new Error(`${launch.name} is not a lens session`);
      }
      return launch.task;
    });
  }

  test("carry the spec and its rule when the issue has one", () => {
    const tasks = lensTasks(stateWith("review", { spec: SPEC }));
    assert.deepEqual(
      tasks,
      LENS_NAMES.map((lens) => lensTask(lens, SPEC)),
    );
    assert.ok(tasks.every((task) => task.includes(SPEC)));
  });

  test("leave the spec out when no spec stage ran", () => {
    const tasks = lensTasks(stateWith("review", { spec: null }));
    assert.deepEqual(
      tasks,
      LENS_NAMES.map((lens) => lensTask(lens)),
    );
    assert.ok(tasks.every((task) => !task.includes(SPEC_HEADING)));
  });
});

describe("a blocking finding", () => {
  test("goes to the aggregator, carrying the raw findings", () => {
    const step = reviewed({ correctness: { findings: [BLOCKING] } });
    assert.deepEqual(launchesOf(step), [
      {
        kind: "child",
        name: "aggregate",
        label: "Merge review findings for issue 7",
        agent: "issue-pipeline-reader",
        model: CTX.models.aggregator,
        schema: AGG_SCHEMA,
        minutes: 10,
        task: aggregateTask(RAW),
      },
    ]);
    assert.deepEqual(step.state.carry, RAW);
    assert.equal(step.state.st.allocated, REVIEWERS_TOKENS + AGGREGATOR_TOKENS);
    assert.match(step.comments.at(0)?.body ?? "", BLOCKING_SECTION);
  });

  test("is numbered f1 and posted by the aggregator, then the issue moves to fix", () => {
    const merged = { blocking: [{ ...OFF_BY_ONE, lenses: ["correctness"] }] };
    const step = aggregated(replied("aggregate", merged));
    assert.deepEqual(step.state.st.findings, [
      openFinding("f1", ["correctness"]),
    ]);
    assert.equal(step.state.st.nextFindingId, 1);
    assert.equal(step.state.st.stage, "fix");
    assert.equal(
      step.state.st.log?.at(-1),
      `${STAMP} review: 1 blocking finding(s)`,
    );
    assert.deepEqual(step.comments, [
      {
        by: { ...signatureOf("aggregate"), role: "aggregator" },
        body: IDS_COMMENT,
        where: "pr",
      },
    ]);
    assert.deepEqual(launchesOf(step), saveOf(step));
  });
});

describe("an aggregator fallback", () => {
  const fallbacks = {
    "a failed aggregator": failed("aggregate", "timed out"),
    "invalid aggregator output": replied("aggregate", { blocking: "f1" }),
  };
  for (const [name, result] of Object.entries(fallbacks)) {
    test(`numbers the raw findings with their lens after ${name}`, () => {
      const step = aggregated(result);
      assert.deepEqual(step.state.st.findings, [
        openFinding("f1", ["correctness"]),
      ]);
      assert.deepEqual(step.comments, [
        {
          by: byStep("aggregator (fallback: raw findings)"),
          body: IDS_COMMENT,
          where: "pr",
        },
      ]);
      assert.equal(step.state.st.stage, "fix");
    });
  }
});

describe("a review that stops", () => {
  test("a failed lens stops with the first failure, after the others' comments", () => {
    const step = reviewed({ correctness: { failed: "timed out" } });
    assert.deepEqual(step.stop, {
      reason: "a reviewer failed",
      detail: "correctness reviewer failed: timed out",
      code: null,
    });
    assert.deepEqual(
      step.comments.map(({ by }) => by.role),
      ["reviewer (tests)", "reviewer (scope)"],
    );
    assert.equal(step.state.st.reviewedSha, null);
  });

  test("a failed prep stops", () => {
    const begun = next(stateWith("review"), CTX, []);
    const step = next(begun.state, CTX, [
      opReply({ ok: false, error: "no diff" }),
    ]);
    assert.deepEqual(step.stop, {
      reason: "could not prepare the review diff",
      detail: "no diff",
      code: null,
    });
  });

  test("a budget smaller than the three reviewers stops before prep", () => {
    const step = next(stateWith("review"), contextWith(SMALL_BUDGET), []);
    assert.equal(step.done, true);
    assert.deepEqual(step.stop, {
      reason: "issue token budget exhausted",
      detail:
        "Allocated 0 of 100000 tokens (issueTokenBudget); the next step (reviewer) needs 180000.",
      code: null,
    });
  });
});
