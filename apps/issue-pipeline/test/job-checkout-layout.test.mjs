// @ts-check
// A stage job's folder holds its code checkout, repo/, and its wiki
// checkout, docs/, side by side (separate-checkouts, #338); every stage gets
// docs/ (every-role-reads-wiki), and teardown finds the work left in either
// (Running-the-Issue-Pipeline, "Stage jobs"). The author reads docs/; the
// implementor writes it (STAGE_WIKI_ACCESS).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  AUTHOR_SESSION,
  AUTHORED,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "./job-fixtures.mjs";
import { checkoutOf, docsOf, repoOf } from "./job-git-test-kit.mjs";
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
  test(`the ${stage} job's folder holds repo/ and docs/ side by side, and is its session's cwd`, async () => {
    const place = setUp(repliesFor(stage), WAITING, {}, { wiki: true });
    const job = startJob(place, ["--stage", stage]);
    const root = checkoutOf(place.root, stage);
    const repo = repoOf(place.root, stage);
    try {
      await waitFor("the session's spending in job.json", () => spent(place));
      assert.ok(fs.existsSync(path.join(repo, ".git")));
      const docs = docsOf(place.root, stage);
      assert.ok(fs.existsSync(path.join(docs, ".git")));
      assert.equal(
        fs.realpathSync(docs),
        fs.realpathSync(path.join(repo, "wiki")),
      );
      assert.equal(fs.existsSync(path.join(root, ".git")), false);
      const exclude = path.join(repo, ".git", "info", "exclude");
      const lines = fs.readFileSync(exclude, "utf8").split("\n");
      assert.deepEqual(
        lines.filter((line) => line.includes("docs") || line.includes("wiki")),
        [],
      );
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

test("an author job gets docs/ to read, and its edits there are lost as docs/ paths", () => {
  const place = setUp(
    repliesAt(READER_STAGE),
    { ...AUTHOR_SESSION, untracked: "docs/Page.md" },
    {},
    { wiki: true },
  );
  const r = runJob(place, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusOf(place).lostChanges, ["docs/Page.md"]);
  assert.deepEqual(pushes(place), []);
  assert.equal(fs.existsSync(checkoutOf(place.root, READER_STAGE)), false);
});

test("an implement job whose only commit is in docs/ still runs its exit push", () => {
  const place = setUp(
    implementReplies(),
    { ...IMPLEMENTOR_SESSION, commit: "docs/Page.md" },
    {},
    { wiki: true },
  );
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

// A writer session's pipeline_commit routes repo/ and docs/ pathspecs from
// its scope's root, so the root must be the job's folder (#338). The
// implementor writes the wiki (STAGE_WIKI_ACCESS).
const SCOPES = [
  { wiki: true, docs: { dir: "docs", access: "write" }, name: "with" },
  { wiki: false, docs: null, name: "without" },
];
for (const { wiki, docs, name } of SCOPES) {
  test(`an implement job ${name} a wiki gives its writer session the commit scope of its folder`, () => {
    const place = setUp(implementReplies(), IMPLEMENTOR_SESSION, {}, { wiki });
    const r = runJob(place, ["--stage", "implement"]);
    assert.equal(r.status, 0, r.stderr);
    const [start] = piStarts(place);
    const scope = start.commitScope;
    assert.equal(scope.root, checkoutOf(place.root, "implement"));
    assert.deepEqual(scope.repo, { dir: "repo", access: "write" });
    assert.deepEqual(scope.docs, docs);
  });
}

// What a stage job's session is told of its folder (#338). The retired
// job preamble's facts now come from the role: the session's cwd is the
// job's folder (above), the author's task names repo/ and docs/ and says it
// only reads, and the implementor's agent definition, its system prompt,
// names repo/ on the issue's branch and docs/ on its wiki branch.
const TOLD = [
  {
    stage: READER_STAGE,
    script: AUTHOR_SESSION,
    facts: ["the repo in `repo/`", "the wiki in `docs/`", "you only read"],
  },
  {
    stage: "implement",
    script: IMPLEMENTOR_SESSION,
    facts: [
      "You work in a stage job's folder, your current directory.",
      "The code checkout is `repo/`, on the issue's branch.",
      "is `docs/`, on the issue's wiki branch.",
    ],
  },
];
for (const { stage, script, facts } of TOLD) {
  test(`the ${stage} job's session is told its folder's repo/ and docs/`, () => {
    const place = setUp(repliesFor(stage), script, {}, { wiki: true });
    const r = runJob(place, ["--stage", stage]);
    assert.equal(r.status, 0, r.stderr);
    const prompt = piCommands(place).find(({ type }) => type === "prompt");
    const [start] = piStarts(place);
    const system = flagValue(start.argv, "--system-prompt");
    const text = `${system}\n${String(prompt?.message)}`;
    for (const fact of facts) {
      assert.ok(text.includes(fact), `${fact} missing from:\n${text}`);
    }
  });
}
