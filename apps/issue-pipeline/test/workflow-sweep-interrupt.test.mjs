// The sweep's interrupt(), which a stopped stage job runs: during the stages
// phase it saves the claimed, open issue at its stage with no lease, and
// before the claim, for a closed issue or once the finish phase has started
// it saves nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startSweep } from "../src/workflow/sweep.ts";

/** @import { LaunchSpec } from "../src/workflow/launches.ts" */
/** @import { Sweep } from "../src/workflow/sweep.ts" */
/**
 * @typedef {object} Run
 * @property {string} stage
 * @property {Record<string, unknown>} ops
 * @property {Record<string, object>} agents
 */
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
} from "./workflow-stages-fixtures.mjs";

const ARGS = { config: "/w/repos/o__r.json", lane: "lane-a", issue: "7" };
const CLOCK = {
  sweepId: "s1",
  now: () => new Date("2026-10-15T12:00:00.000Z"),
};
const OPS_REQUEST = /^BEGIN_OPS_REQUEST\n(?<json>.*)\nEND_OPS_REQUEST$/u;
const SEQUENCE = /-\d+$/u;
const PR = 42;
const REVIEW_COMMENT = /^Review of bbbbbbb for correctness\./u;
const BLOCKING = {
  severity: "blocking",
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
};
const NO_FINDINGS = replyWith({ findings: [] });
// Issue #7 claimed at review, whose correctness reviewer finds a blocking
// finding, so the reviewers' comments are queued while the aggregator runs.
const REVIEW_RUN = {
  stage: "review",
  ops: {
    ...ROUTINE_OPS,
    sweep: sweepReply({ items: [ISSUE] }),
    claim: claimAt("review", { pr: PR, headSha: "bbbbbbb", plan: "p" }),
    "prepare-review": {
      ok: true,
      headSha: "bbbbbbb",
      diffPath: "/runs/issue-7/r0.diff",
      diffLines: 40,
    },
  },
  agents: {
    "i7-review-correctness": replyWith({ findings: [BLOCKING] }),
    "i7-review-tests": NO_FINDINGS,
    "i7-review-scope": NO_FINDINGS,
  },
};
// Issue #7 claimed at spec, whose writer needs more information, so the
// issue is closed while its ask op runs.
const NEEDS_INFO_RUN = {
  stage: "spec",
  ops: {
    ...ROUTINE_OPS,
    sweep: sweepReply({ items: [ISSUE] }),
    claim: claimAt("spec", { plan: "p" }),
    ask: { ok: true },
  },
  agents: {
    "i7-spec": replyWith({
      decision: "needs-info",
      spec: "So far.\n<!-- end of spec -->",
      questions: ["Which file?"],
      files: [],
      subIssues: [],
    }),
  },
};

/** @param {LaunchSpec | null} spec @returns {any} its ops request, or null */
function requestOf(spec) {
  const { json } = OPS_REQUEST.exec(spec?.task ?? "")?.groups ?? {};
  if (json === undefined) {
    return null;
  }
  return JSON.parse(json);
}

// The raw result for `spec`: the scripted reply for its op or session key.
/** @param {LaunchSpec} spec @param {Run} run */
function rawResult(spec, run) {
  const request = requestOf(spec);
  if (request !== null) {
    const reply = run.ops[request.op] ?? { ok: false, error: "unscripted" };
    return { ok: true, key: spec.key, output: JSON.stringify(reply) };
  }
  const reply = run.agents[spec.key.replace(SEQUENCE, "")];
  return { ok: false, error: "unscripted", ...reply, key: spec.key };
}

// Starts `run`'s sweep and answers its batches until one has a launch named
// `name` in flight. Returns the sweep, ready to be interrupted.
/** @param {Run} run @param {string} name @returns {Sweep} */
function sweepAt(run, name) {
  const sweep = startSweep({ ...ARGS, stage: run.stage }, CLOCK);
  let specs = sweep.next([]);
  while (!specs.some(({ key }) => key.replace(SEQUENCE, "") === name)) {
    if (specs.length === 0) {
      throw new Error(`the sweep never launched ${name}`);
    }
    specs = sweep.next(specs.map((spec) => rawResult(spec, run)));
  }
  return sweep;
}

test("before the claim, interrupt saves nothing", () => {
  assert.equal(startSweep(ARGS, CLOCK).interrupt(), null);
  assert.equal(sweepAt(REVIEW_RUN, "sweep").interrupt(), null);
  assert.equal(sweepAt(REVIEW_RUN, "i7-claim").interrupt(), null);
});

test("during a stage, interrupt saves the issue at its stage with no lease and its queued comments", () => {
  const spec = sweepAt(REVIEW_RUN, "i7-aggregate").interrupt();
  const request = requestOf(spec);
  assert.equal(request.op, "save-state");
  assert.equal(request.number, ISSUE);
  assert.equal(request.state.stage, "review");
  assert.equal(request.state.lease, null);
  // Each reviewer's comment, on the PR.
  assert.deepEqual(
    request.comments.map(
      (/** @type {{ number: number }} */ { number }) => number,
    ),
    [PR, PR, PR],
  );
  assert.ok(
    request.comments.some((/** @type {{ body: string }} */ { body }) =>
      REVIEW_COMMENT.test(body),
    ),
  );
});

test("once the finish phase has started, interrupt saves nothing", () => {
  assert.equal(sweepAt(REVIEW_RUN, "i7-release").interrupt(), null);
  assert.equal(sweepAt(REVIEW_RUN, "cleanup").interrupt(), null);
});

test("a closed issue is not saved", () => {
  assert.equal(sweepAt(NEEDS_INFO_RUN, "i7-ask").interrupt(), null);
});
