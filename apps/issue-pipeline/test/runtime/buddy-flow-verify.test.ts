// Verify through the supported buddy entrypoint, end to end on a disposable
// machine: a Developer implements a human-started issue and opens its PR;
// a Gatekeeper's Verify, woken by that result, runs the project's check on
// exactly the PR head, reads its required CI, reviews it in one read-only
// Reviewer session and submits one GitHub review of that head through the
// landing account (docs/decisions/pr-review.md `verify-reviews-the-pr`).
// The built buddy.mjs runs the real tasks, ops, ledger and Git; only gh
// (fake-gh.ts) and pi (fake-pi.ts) are fakes.
//
// - Nothing but nits approves, posting the nits as non-blocking comments.
// - A blocking finding, a Security finding of any severity, failing checks
//   and failing CI each request changes; a finding on lines outside the
//   diff goes in the review body.
// - A read-only session that writes in its checkout records no pass and
//   submits no review.
// - A Verify whose result post is lost settles its original run from the
//   review it already submitted, and never submits a second one.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import type { FakeReview, World } from "../signals/fake-github-world.ts";
import { LANDING } from "../signals/signal-test-kit.ts";
import type {
  ActionRun,
  BuddyOutcome,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const IMPLEMENTS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count the widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
// The Developer's sessions until Implement's passed result: Implement acts
// on the first poll and the second stops the run.
const DEVELOPER_SESSIONS: PlannedSession[] = [IMPLEMENTS];
const DEVELOPER_POLLS = 2;
// Verify acts on the first poll; the second finds its binding passed or
// refused; the third stops the run.
const GATEKEEPER_POLLS = 3;
// Verify's uncertain run, its read-only recovery, an idle poll, then stop.
const RECOVERY_POLLS = 4;
const BRANCH = `agent/issue-${ISSUE}`;
const RESULT = z.looseObject({
  kind: z.literal("result"),
  run: z.looseObject({ id: z.uuid() }),
  verdict: z.string(),
  receipt: z.unknown(),
});
const MARK = /\n\n<!-- agent-pipeline:verify-review\n\{.*\}\n-->$/su;

function reviewOf(findings: unknown[]): PlannedSession {
  return {
    commit: null,
    change: null,
    changeFirst: false,
    awaitAbort: false,
    reply: { summary: "Read the whole diff.", findings },
  };
}

// The machine, after a Developer implemented the issue and opened its PR
// at `head`, whose required CI reports `ci`.
async function implemented(
  ci: "pass" | "fail",
  signal: AbortSignal,
  setup: Parameters<typeof machine>[1] = { landPermission: false },
): Promise<{ box: Machine; head: string }> {
  const box = machine(undefined, setup);
  const developer = await box.runBuddy(
    DEVELOPER_SESSIONS,
    DEVELOPER_POLLS,
    { role: "developer", tasks: ["implement"] },
    signal,
  );
  signal.throwIfAborted();
  if (developer.status !== 0) {
    throw new Error(`the Developer exited ${String(developer.status)}`);
  }
  const head = box.git(["rev-parse", BRANCH]);
  box.change((world) => {
    world.checks = { [head]: [{ name: "ci", bucket: ci }] };
  });
  return { box, head };
}

function verifyActions(outcome: BuddyOutcome): ActionRun[] {
  return outcome.actions.filter(
    (action) =>
      action.task === "verify" &&
      action.buddyRun === outcome.run.id &&
      action.state !== "waiting",
  );
}

function onlyVerify(outcome: BuddyOutcome): ActionRun {
  const [action, ...more] = verifyActions(outcome);
  if (action === undefined || more.length > 0) {
    throw new Error("not exactly one Verify action in the run");
  }
  return action;
}

function opsOf(action: ActionRun): (string | null)[][] {
  return action.operations.map((item) => [item.op, item.outcome]);
}

function pullOf(world: World): NonNullable<World["pulls"]>[number] {
  const [pull, ...more] = world.pulls ?? [];
  if (pull === undefined || more.length > 0) {
    throw new Error("not exactly one PR");
  }
  return pull;
}

// The item's results of `action`'s run, oldest first.
function resultsOf(world: World, action: ActionRun): z.infer<typeof RESULT>[] {
  return marked(world, "task-result")
    .filter((record) => record.kind === "result")
    .map((record) => RESULT.parse(record))
    .filter((record) => record.run.id === action.id);
}

// The comment ids of the item's v2 records, by the run they record.
function recordIdsOf(world: World, task: string): number[] {
  const issue = world.issues.find((item) => item.number === ISSUE);
  return (issue?.comments ?? [])
    .filter(
      (comment) =>
        comment.body.includes('"kind":"result"') &&
        comment.body.includes(`"task":"${task}"`),
    )
    .map((comment) => comment.id);
}

function reviewPosts(box: Machine): string[] {
  return box
    .calls()
    .filter(
      (call) =>
        call.args.includes("POST") &&
        call.args.some((arg) => arg.endsWith("/reviews")),
    )
    .map((call) => call.login);
}

function bodyOf(review: FakeReview): string {
  return review.body.replace(MARK, "");
}

function finish(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`Verify fixture retained: ${box.root}\n`);
}

test("Verify approves a head with only nits through the landing account, bound to that head", async ({
  signal,
}) => {
  const { box, head } = await implemented("pass", signal);
  let passed = false;
  try {
    const gatekeeper = await box.runBuddy(
      [
        reviewOf([
          {
            path: "counter.txt",
            line: 1,
            body: "Say what the count counts.",
            severity: "nit",
            security: false,
          },
          {
            body: "The commit message could name the issue.",
            severity: "nit",
            security: false,
          },
        ]),
      ],
      GATEKEEPER_POLLS,
      { role: "gatekeeper", tasks: ["verify"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const verify = onlyVerify(gatekeeper);
    const reason = `Verify approved ${head} with 2 nits`;
    assert.deepEqual(
      [verify.mode, verify.state, verify.verdict, verify.reason],
      ["act", "ended", "passed", reason],
    );
    assert.deepEqual(opsOf(verify), [
      ["task-attempt", "ok"],
      ["verify-task", "ok"],
      ["task-result", "ok"],
    ]);
    assert.deepEqual(
      verify.sessions.map((item) => [
        item.agent,
        item.phase,
        item.commits,
        item.outcome,
      ]),
      [["issue-pipeline-reviewer", "security-review", false, "ok"]],
    );
    assert.equal(verify.ownership.state, "released");
    // Implement's passed result woke it, and it bound exactly that head.
    const world = box.world();
    const [implementResult] = recordIdsOf(world, "implement");
    assert.equal(verify.cause.signal, `result:${String(implementResult)}`);
    assert.ok("revision" in verify.binding);
    assert.equal(verify.binding.revision.code, head);
    // The project's check ran once, on the head.
    assert.deepEqual(box.checksRun(), [head]);

    // One approval by the landing account on exactly the head: the
    // general nit in its body, the line nit inline, each non-blocking.
    const pull = pullOf(world);
    const [review, ...others] = pull.reviews ?? [];
    assert.ok(review !== undefined);
    assert.deepEqual(others, []);
    assert.deepEqual(
      [review.author, review.state, review.commitId],
      [LANDING, "APPROVED", head],
    );
    assert.equal(
      bodyOf(review),
      [
        "Read the whole diff.",
        "",
        "Findings:",
        "",
        "- **Nit (non-blocking)**: The commit message could name the issue.",
      ].join("\n"),
    );
    assert.deepEqual(
      (pull.reviewComments ?? []).map((comment) => [
        comment.review,
        comment.author,
        comment.path,
        comment.line,
        comment.commitId,
        comment.body,
      ]),
      [
        [
          review.id,
          LANDING,
          "counter.txt",
          1,
          head,
          "**Nit (non-blocking)**: Say what the count counts.",
        ],
      ],
    );
    assert.deepEqual(reviewPosts(box), [LANDING]);

    // Its one result mirrors the review it submitted.
    const results = resultsOf(world, verify);
    assert.deepEqual(
      results.map((record) => [record.verdict, record.receipt]),
      [
        [
          "passed",
          {
            summary: reason,
            evidence: {
              review: {
                id: review.id,
                pr: pull.number,
                commit: head,
                state: "APPROVED",
              },
              blocking: 0,
              nits: 2,
              security: false,
            },
          },
        ],
      ],
    );
    // The idle poll leaves the passed binding waiting; nothing ran again.
    assert.deepEqual(
      gatekeeper.run.loops.map((loop) => [loop.task, loop.action, loop.reason]),
      [["verify", verify.id, "verify passed this binding"]],
    );
    passed = true;
  } finally {
    finish(box, passed);
  }
});

test("Verify requests changes for blocking, Security, failed-check and failed-CI findings", async ({
  signal,
}) => {
  // The project's check fails only in Verify's own detached checkout.
  const { box, head } = await implemented("fail", signal, {
    landPermission: false,
    test: 'case "$PWD" in */verify-checkout-*/repo) exit 1;; esac',
  });
  let passed = false;
  try {
    const gatekeeper = await box.runBuddy(
      [
        reviewOf([
          {
            path: "counter.txt",
            line: 1,
            body: "The count is hard-coded; count the widgets.",
            severity: "blocking",
            security: false,
          },
          {
            body: "abuse-risk: the counter trusts its input unchecked.",
            severity: "nit",
            security: true,
          },
          {
            path: "README.md",
            line: 1,
            body: "Mention the counter.",
            severity: "nit",
            security: false,
          },
        ]),
      ],
      GATEKEEPER_POLLS,
      { role: "gatekeeper", tasks: ["verify"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const verify = onlyVerify(gatekeeper);
    const reason = `Verify requested changes on ${head}: 4 blocking findings, a Security finding among them, and 1 nit`;
    assert.deepEqual(
      [verify.state, verify.verdict, verify.reason],
      ["ended", "refused", reason],
    );
    assert.deepEqual(opsOf(verify), [
      ["task-attempt", "ok"],
      ["verify-task", "ok"],
      ["task-result", "ok"],
    ]);
    const world = box.world();
    const pull = pullOf(world);
    const [review, ...others] = pull.reviews ?? [];
    assert.ok(review !== undefined);
    assert.deepEqual(others, []);
    assert.deepEqual(
      [review.author, review.state, review.commitId],
      [LANDING, "CHANGES_REQUESTED", head],
    );
    // The Security finding blocks though the session called it a nit; the
    // README line is outside the diff, so it goes in the body.
    assert.equal(
      bodyOf(review),
      [
        "Read the whole diff.",
        "",
        "Findings:",
        "",
        "- **Security (blocking)**: abuse-risk: the counter trusts its input unchecked.",
        "- **Nit (non-blocking)** `README.md:1`: Mention the counter.",
        `- **Blocking**: The full checks failed on ${head}: test.`,
        `- **Blocking**: Required CI failed: the required CI checks ci failed on ${head}.`,
      ].join("\n"),
    );
    assert.deepEqual(
      (pull.reviewComments ?? []).map((comment) => [
        comment.path,
        comment.line,
        comment.body,
      ]),
      [
        [
          "counter.txt",
          1,
          "**Blocking**: The count is hard-coded; count the widgets.",
        ],
      ],
    );
    assert.deepEqual(
      resultsOf(world, verify).map((record) => [
        record.verdict,
        record.receipt,
      ]),
      [
        [
          "refused",
          {
            summary: reason,
            evidence: {
              review: {
                id: review.id,
                pr: pull.number,
                commit: head,
                state: "CHANGES_REQUESTED",
              },
              blocking: 4,
              nits: 1,
              security: true,
            },
          },
        ],
      ],
    );
    // A refused binding is never retried automatically: the idle poll
    // holds it rather than reviewing again.
    assert.deepEqual(
      gatekeeper.run.loops.map((loop) => [loop.task, loop.action, loop.state]),
      [["verify", verify.id, "held"]],
    );
    assert.deepEqual(reviewPosts(box), [LANDING]);
    passed = true;
  } finally {
    finish(box, passed);
  }
});

test("Verify records no pass and submits no review when its read-only session writes in its checkout", async ({
  signal,
}) => {
  const { box, head } = await implemented("pass", signal);
  let passed = false;
  try {
    const strays: PlannedSession = {
      ...reviewOf([]),
      strayWrite: { file: "counter.txt", content: "0 widgets\n" },
    };
    const gatekeeper = await box.runBuddy(
      [strays],
      GATEKEEPER_POLLS,
      { role: "gatekeeper", tasks: ["verify"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const verify = onlyVerify(gatekeeper);
    assert.deepEqual(
      [verify.state, verify.verdict, verify.reason],
      [
        "ended",
        "failed",
        `the read-only review session changed what it reviewed: its checkout differs from ${head}: M counter.txt`,
      ],
    );
    assert.deepEqual(opsOf(verify), [
      ["task-attempt", "ok"],
      ["verify-unjudged", "ok"],
      ["task-result", "ok"],
    ]);
    const world = box.world();
    assert.deepEqual(
      resultsOf(world, verify).map((record) => record.verdict),
      ["failed"],
    );
    assert.deepEqual(pullOf(world).reviews ?? [], []);
    assert.deepEqual(reviewPosts(box), []);
    assert.deepEqual(box.checksRun(), []);
    assert.equal(box.git(["rev-parse", BRANCH]), head);
    passed = true;
  } finally {
    finish(box, passed);
  }
});

test("a Verify whose result post is lost settles from its submitted review without a second one", async ({
  signal,
}) => {
  const { box, head } = await implemented("pass", signal);
  let passed = false;
  try {
    box.change((reported) => {
      reported.failPostOnceContaining = `"summary":"Verify approved ${head}`;
    });
    const gatekeeper = await box.runBuddy(
      [reviewOf([])],
      RECOVERY_POLLS,
      { role: "gatekeeper", tasks: ["verify"] },
      signal,
    );
    signal.throwIfAborted();
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    const actions = verifyActions(gatekeeper);
    const original = actions.find((action) => action.mode === "act");
    const reconciler = actions.find((action) => action.mode === "recover");
    assert.ok(original !== undefined && reconciler !== undefined);
    assert.equal(actions.length, 2);
    // The original submitted its review, then lost its result's post.
    assert.deepEqual(
      [original.verdict, opsOf(original)],
      [
        "unknown",
        [
          ["task-attempt", "ok"],
          ["verify-task", "failed"],
          ["task-result", "ok"],
        ],
      ],
    );
    const world = box.world();
    const pull = pullOf(world);
    const [review, ...others] = pull.reviews ?? [];
    assert.ok(review !== undefined);
    assert.deepEqual(others, []);
    assert.deepEqual([review.state, review.commitId], ["APPROVED", head]);
    // Its recovery read that review and settled the original run, with no
    // session, check or review of its own.
    const reason = `Verify approved ${head} with 0 nits (reconciled by ${reconciler.id})`;
    assert.deepEqual(
      [
        reconciler.previous,
        reconciler.verdict,
        reconciler.reason,
        opsOf(reconciler),
        reconciler.sessions,
      ],
      [original.id, "passed", reason, [["verify-reconcile", "ok"]], []],
    );
    assert.deepEqual(reconciler.binding, original.binding);
    assert.deepEqual(
      resultsOf(world, original).map((record) => record.verdict),
      ["unknown", "passed"],
    );
    assert.deepEqual(resultsOf(world, original).at(-1)?.receipt, {
      summary: reason,
      evidence: {
        review: {
          id: review.id,
          pr: pull.number,
          commit: head,
          state: "APPROVED",
        },
        blocking: 0,
        nits: 0,
        security: false,
      },
    });
    assert.deepEqual(reviewPosts(box), [LANDING]);
    assert.deepEqual(box.checksRun(), [head]);
    passed = true;
  } finally {
    finish(box, passed);
  }
});
