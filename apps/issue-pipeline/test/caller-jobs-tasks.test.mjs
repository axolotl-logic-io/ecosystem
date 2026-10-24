// @ts-check
// The caller's task requests (#186) through the launcher,
// scripts/caller-jobs.ts: `start --task --binding` relays exactly the task
// and binding a job printed, refuses a request for another task, issue,
// repository, target branch or stage before anything starts, and counts a
// task job under every cap, exclusion and attempt limit. `status` reports a
// task job's task apart from how its job ended: held and unknown are never
// completed. Every review start hardens as Hippy. caller-jobs-test-kit.mjs's
// fake job and fake gh stand in for the job and GitHub.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import {
  FOURTH_ISSUE,
  hasStarted,
  hasStatusFile,
  ISSUE,
  issuesOnGitHub,
  launcher,
  newRun,
  receiptsOf,
  refusal,
  release,
  SECOND_ISSUE,
  SLUG,
  seenBy,
  start,
  THIRD_ISSUE,
} from "./caller-jobs-test-kit.mjs";

const REFUSED = 2;
// The arguments a task request adds: --task, its name, --binding, its JSON.
const REQUEST_ARGS = 4;
const OTHER_ISSUE = /binding is for o\/r#8, not o\/r#7/u;
const SHA_LENGTH = 40;
const DIGEST_LENGTH = 64;

/**
 * A `task` binding of `issue`'s revision on the config's target, `main`.
 * @param {string} task @param {number} [issue] @param {Record<string, unknown>} [over]
 */
function bindingOf(task, issue = ISSUE, over = {}) {
  return {
    repo: "o/r",
    workItem: issue,
    task,
    revision: {
      code: "a".repeat(SHA_LENGTH),
      inputs: "b".repeat(DIGEST_LENGTH),
      policy: "c".repeat(DIGEST_LENGTH),
    },
    target: { branch: "main", commit: "d".repeat(SHA_LENGTH) },
    ...over,
  };
}

/** @param {string} task @param {unknown} binding @returns {string[]} */
function requestArgs(task, binding) {
  return ["--task", task, "--binding", JSON.stringify(binding)];
}

/** @param {string} run @returns {any[]} */
function statusOf(run) {
  return launcher(["status", "--run", run]).lines;
}

/** @param {string} run */
async function allEnded(run) {
  await waitFor("every job's end", () =>
    statusOf(run).every((job) => !job.running),
  );
}

test("a task request starts its task job with the exact binding in a receipt of its own, and every review hardens as Hippy", async () => {
  issuesOnGitHub();
  const run = newRun({});
  const review = start(run, ISSUE, "review");
  assert.equal(review.code, 0, review.stderr);
  await waitFor("the review job", () => hasStarted(ISSUE));
  assert.deepEqual(seenBy(ISSUE).argv.slice(-2), [
    "--hardening-buddy",
    "hippy",
  ]);
  release(ISSUE, "wait");
  await allEnded(run);
  const binding = bindingOf("Sync");
  const out = start(run, ISSUE, "review", requestArgs("sync", binding));
  assert.equal(out.code, 0, out.stderr);
  const [launch] = out.lines;
  assert.equal(
    launch.receipt,
    path.join(run, "jobs", SLUG, "issue-7", "sync-1"),
  );
  assert.equal(launch.task, "sync");
  assert.deepEqual(launch.binding, binding);
  await waitFor("the Sync job", () => seenBy(ISSUE).argv.includes("--task"));
  const { argv } = seenBy(ISSUE);
  assert.deepEqual(argv.slice(-REQUEST_ARGS), [
    "--task",
    "sync",
    "--binding",
    JSON.stringify(binding),
  ]);
  assert.equal(argv.includes("--hardening-buddy"), false);
  release(ISSUE, "next");
  await allEnded(run);
});

test("a request for another task, issue, repository, target branch or stage, or a closed issue, is refused before anything starts", () => {
  issuesOnGitHub([THIRD_ISSUE]);
  const run = newRun({});
  const cases = [
    [ISSUE, "review", requestArgs("integration", bindingOf("Sync"))],
    [ISSUE, "review", requestArgs("sync", bindingOf("Sync", SECOND_ISSUE))],
    [
      ISSUE,
      "review",
      requestArgs("sync", bindingOf("Sync", ISSUE, { repo: "o/other" })),
    ],
    [
      ISSUE,
      "review",
      requestArgs(
        "sync",
        bindingOf("Sync", ISSUE, {
          target: { branch: "release", commit: "d".repeat(SHA_LENGTH) },
        }),
      ),
    ],
    [ISSUE, "review", requestArgs("integration", bindingOf("Integration"))],
    [ISSUE, "implement", requestArgs("sync", bindingOf("Sync"))],
    [ISSUE, "merge", ["--task", "sync"]],
    [ISSUE, "merge", ["--task", "sync", "--binding", "{not json"]],
    [ISSUE, "merge", requestArgs("sync", { ...bindingOf("Sync"), extra: 1 })],
    [
      THIRD_ISSUE,
      "merge",
      requestArgs("integration", bindingOf("Integration", THIRD_ISSUE)),
    ],
  ];
  for (const [issue, stage, extra] of cases) {
    const out = start(
      run,
      /** @type {number} */ (issue),
      /** @type {string} */ (stage),
      /** @type {string[]} */ (extra),
    );
    assert.equal(
      out.code,
      REFUSED,
      `${stage} ${JSON.stringify(extra)}: ${out.stderr}`,
    );
  }
  assert.deepEqual(receiptsOf(run), []);
  assert.equal(hasStarted(ISSUE), false);
  assert.equal(hasStarted(THIRD_ISSUE), false);
  assert.match(
    refusal(
      start(
        run,
        ISSUE,
        "review",
        requestArgs("sync", bindingOf("Sync", SECOND_ISSUE)),
      ),
    ),
    OTHER_ISSUE,
  );
});

test("a task counts under every cap, live job, exclusion and attempt limit, with its own stage cap", async () => {
  issuesOnGitHub();
  const run = newRun({
    maxJobs: 2,
    maxStageJobs: { sync: 1 },
    maxAttempts: 1,
    excludedIssues: { "o/r": [THIRD_ISSUE] },
  });
  const sync = requestArgs("sync", bindingOf("Sync"));
  assert.equal(start(run, ISSUE, "merge", sync).code, 0);
  await waitFor("the Sync job's job.json", () => hasStatusFile(ISSUE));
  // A live task job holds its issue and branch like any job.
  assert.equal(
    refusal(start(run, ISSUE, "merge")),
    "#7 already has a live job",
  );
  // Its own stage cap.
  assert.equal(
    refusal(
      start(
        run,
        SECOND_ISSUE,
        "merge",
        requestArgs("sync", bindingOf("Sync", SECOND_ISSUE)),
      ),
    ),
    "1 sync jobs are live; the cap is 1",
  );
  // Integration doesn't write the target, so it isn't the repo's merge.
  const integration = requestArgs(
    "integration",
    bindingOf("Integration", SECOND_ISSUE),
  );
  assert.equal(start(run, SECOND_ISSUE, "merge", integration).code, 0);
  // The global cap counts both.
  assert.equal(
    refusal(start(run, FOURTH_ISSUE, "author")),
    "2 jobs are live; the cap is 2",
  );
  // An excluded issue stays excluded for a task.
  assert.equal(
    refusal(
      start(
        run,
        THIRD_ISSUE,
        "merge",
        requestArgs("sync", bindingOf("Sync", THIRD_ISSUE)),
      ),
    ),
    "#9 is excluded this run",
  );
  release(ISSUE, "next");
  release(SECOND_ISSUE, "next");
  await allEnded(run);
  // Attempts count per task: a second Sync is out of attempts, while the
  // merge stage itself still has its own.
  assert.equal(
    refusal(start(run, ISSUE, "merge", sync)),
    "#7 sync has used its 1 attempts",
  );
  assert.equal(start(run, ISSUE, "merge").code, 0);
  release(ISSUE, "wait");
  await allEnded(run);
});

/**
 * Starts a Sync task job on `issue` and ends it with `line`.
 * @param {string} run @param {number} issue @param {Record<string, unknown> | "crash"} line
 */
async function syncEnding(run, issue, line) {
  const out = start(
    run,
    issue,
    "merge",
    requestArgs("sync", bindingOf("Sync", issue)),
  );
  if (out.code !== 0) {
    throw new Error(out.stderr);
  }
  await waitFor("the Sync job", () => hasStarted(issue));
  let ending = "crash";
  if (line !== "crash") {
    ending = JSON.stringify(line);
  }
  release(issue, ending);
}

test("status reports a task apart from its job's end: held and unknown are never completed", async () => {
  issuesOnGitHub();
  const run = newRun({ maxJobs: 4 });
  const binding = bindingOf("Sync");
  const run1 = { id: "11111111-1111-4111-8111-111111111111", previous: null };
  await syncEnding(run, ISSUE, {
    end: "next",
    task: { task: "Sync", binding, run: run1, verdict: "passed" },
  });
  await syncEnding(run, SECOND_ISSUE, {
    end: "stop",
    task: { task: "Sync", binding, run: null, verdict: "held" },
  });
  await syncEnding(run, THIRD_ISSUE, "crash");
  await syncEnding(run, FOURTH_ISSUE, {
    end: "stop",
    task: { task: "Sync", binding, run: run1, verdict: "unknown" },
  });
  await allEnded(run);
  const states = Object.fromEntries(
    statusOf(run).map((job) => [
      job.issue,
      [job.result?.end ?? null, job.taskState],
    ]),
  );
  assert.deepEqual(states, {
    7: ["next", "completed"],
    8: ["stop", "held"],
    9: [null, "unknown"],
    10: ["stop", "unknown"],
  });
});

test("status relays a waiting stage job's task request exactly as the job printed it", async () => {
  issuesOnGitHub();
  const run = newRun({});
  assert.equal(start(run, ISSUE, "merge").code, 0);
  await waitFor("the merge job", () => hasStarted(ISSUE));
  const request = { task: "Integration", binding: bindingOf("Integration") };
  release(
    ISSUE,
    JSON.stringify({
      end: "wait",
      reason: "Integration is requested",
      request,
    }),
  );
  await allEnded(run);
  const [job] = statusOf(run);
  assert.equal(job.taskState, null, "a stage job runs no task");
  assert.deepEqual(job.request, request);
  const relayed = start(
    run,
    ISSUE,
    "merge",
    requestArgs(request.task.toLowerCase(), job.request.binding),
  );
  assert.equal(relayed.code, 0, relayed.stderr);
  release(ISSUE, "next");
  await allEnded(run);
});
