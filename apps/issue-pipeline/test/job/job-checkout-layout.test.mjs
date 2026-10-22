// @ts-check
// A stage job's folder holds its code checkout, repo/, whose docs/ is
// ordinary tracked Markdown, and teardown finds the work left in it
// (Pipeline-Job-Contract#recovery-and-checkout-boundaries). The author reads
// repo/docs/; the implementor writes it with the code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "../bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "../fake-rpc-pi.mjs";
import {
  AUTHOR_SESSION,
  AUTHORED,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "../job-fixtures.mjs";
import { checkoutOf, repoOf } from "../job-git-test-kit.mjs";
import { pageTextOf } from "../prompt-test-kit.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const ISSUE = 7;
// A session that waits until it is stopped.
const WAITING = { events: [messageEnd(USAGE), "wait", outputEnd(AUTHORED)] };

// Every op's reply for a `stage` job: the author's, or the implementor's.
/** @param {string} stage @returns {{ claim: object } & Record<string, unknown>} */
function repliesFor(stage) {
  if (stage === READER_STAGE) {
    return repliesAt(READER_STAGE);
  }
  return implementReplies();
}

/** @param {Place} place @returns {boolean} whether a launch spent tokens */
function spent(place) {
  const launches = statusOf(place)?.launches ?? [];
  return launches.some((/** @type {any} */ launch) => launch.usage.input > 0);
}

/** @param {Place} place @returns {any[]} the exit-push requests */
function pushes(place) {
  return logOf(place, "ops.log").filter(({ op }) => op === "exit-push");
}

for (const stage of [READER_STAGE, "implement"]) {
  test(`the ${stage} job's folder holds repo/ alone, and is its session's cwd`, async () => {
    const place = setUp(repliesFor(stage), WAITING);
    const job = startJob(place, ["--stage", stage]);
    const root = checkoutOf(place.root, stage);
    const repo = repoOf(place.root, stage);
    try {
      await waitFor("the session's spending in job.json", () => spent(place));
      assert.ok(fs.existsSync(path.join(repo, ".git")));
      assert.ok(fs.existsSync(path.join(repo, "docs", "Home.md")));
      assert.deepEqual(fs.readdirSync(root), ["repo"]);
      const [start] = piStarts(place);
      const realRoot = checkoutOf(fs.realpathSync(place.root), stage);
      assert.equal(start.cwd, realRoot);
    } finally {
      job.child.kill("SIGTERM");
      await job.end;
    }
    assert.equal(fs.existsSync(root), false);
  });
}

test("an implement job whose only commit is in repo/docs/ runs its exit push", () => {
  const place = setUp(implementReplies(), {
    ...IMPLEMENTOR_SESSION,
    commit: "repo/docs/Page.md",
  });
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  const [push] = pushes(place);
  assert.deepEqual(push?.checkout, {
    issue: ISSUE,
    dir: repoOf(place.root, "implement"),
    branch: "agent/issue-7",
  });
  assert.deepEqual(statusOf(place).lostChanges, []);
});

// A writer session's pipeline_commit routes repo/ pathspecs from its scope's
// root, so the root must be the job's folder (#338).
test("an implement job gives its writer session the commit scope of its folder", () => {
  const place = setUp(implementReplies(), IMPLEMENTOR_SESSION);
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(place);
  const scope = start.commitScope;
  assert.equal(scope.root, checkoutOf(place.root, "implement"));
  assert.deepEqual(scope.repo, { dir: "repo", access: "write" });
  assert.ok(!("docs" in scope));
});

// Checkouts are assignment facts in the task; behavior comes from the
// pinned prompt page, not duplicated instructions in a bundled definition.
const TOLD = [
  {
    stage: READER_STAGE,
    script: AUTHOR_SESSION,
    page: "author.md",
  },
  {
    stage: "implement",
    script: IMPLEMENTOR_SESSION,
    page: "developer.md",
  },
];
for (const { stage, script, page } of TOLD) {
  test(`the ${stage} job's session gets its checkout facts and pinned prompt behavior`, () => {
    const place = setUp(repliesFor(stage), script);
    const r = runJob(place, ["--stage", stage]);
    assert.equal(r.status, 0, r.stderr);
    const prompt = piCommands(place).find(({ type }) => type === "prompt");
    const [start] = piStarts(place);
    assert.equal(
      flagValue(start.argv, "--append-system-prompt"),
      pageTextOf(page),
    );
    const text = String(prompt?.message);
    const fact = "repo/";
    assert.ok(text.includes(fact), `${fact} missing from:\n${text}`);
  });
}
