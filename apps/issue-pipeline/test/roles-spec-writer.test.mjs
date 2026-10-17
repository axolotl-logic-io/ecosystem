// @ts-check
// The spec writer on the runner with its real checks (#334), on bare origins
// for the code and the wiki: the branch and wiki branch it pushes, the draft
// PR on ready, found again on a rerun, a long spec saved to spec.md, the
// resets on needs-info, split and no-work, which the job's exit push leaves
// as they are and which delete the handoff (#335), the no-work check's three
// answers, the wiki-only path, a failed start-pr, the retry, a stacked
// issue's base, and the spec draft and the handoff, which a posted spec drops
// (#335). Every run is made before the tests, because the fake gh's writes
// are global.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { refOf } from "./job-git-test-kit.mjs";
import { BRANCH, specWriter } from "./spec-writer-git-test-kit.mjs";
import { INTERFACE, part, replyOf } from "./spec-writer-role-test-kit.mjs";
import {
  countOf,
  PR,
  SPEC_FILE,
  specPosts,
} from "./spec-writer-run-test-kit.mjs";

/** @typedef {Awaited<ReturnType<typeof specWriter>>} Ran */

const CODE = {
  "test/quota.test.sh": "exit 1\n",
  "src/quota.ts": "export function parseQuota() {}\n",
};
const WIKI = { "Quota.md": "Quota.\n", "Home.md": "base\nSee [[Quota]].\n" };
const WIKI_FILES = ["wiki/Quota.md", "wiki/Home.md"];
const FILES = ["test/quota.test.sh", "src/quota.ts", ...WIKI_FILES];
const READY = { replies: [replyOf({ files: FILES })], code: CODE, wiki: WIKI };
// The state's limit on a spec; a longer one goes to spec.md.
const SPEC_LIMIT = 12_000;
// Enough six-character sentences to pass the limit.
const FILLER = 2500;
const LONG_SPEC = `## Behaviour\n\n- It works.\n\n## Design\n\n${"Long. ".repeat(FILLER)}\n\n<!-- end of spec -->`;
const EARLIER_PR = 41;
const NEEDS_INFO = replyOf({ decision: "needs-info", questions: ["Why?"] });
const SPLIT = replyOf({ decision: "split", subIssues: [part("A"), part("B")] });
const NO_WORK = replyOf({ decision: "no-work", files: [] });
const PASSING = { "test/quota.test.sh": "exit 0\n" };
// What the failing test prints, which the retry's session is shown.
const FAILURE = "quota is unparsed";
const FAILING = { "test/quota.test.sh": `echo ${FAILURE}\nexit 1\n` };
const WIKI_ONLY = replyOf({
  files: WIKI_FILES,
  interfaces: [],
  noTestsReason: "The change is to the wiki only.",
});
// The handoff an earlier session of the stage left.
const EARLIER = "Earlier.\n";
const GAP = replyOf({
  files: FILES,
  interfaces: [{ ...INTERFACE, behaviours: ["Something else."] }],
});

/** @param {readonly string[][]} writes @returns {string[]} the bodies `start-pr` gave the draft PR */
function prBodies(writes) {
  return writes
    .filter(
      ([cmd, sub]) => cmd === "pr" && (sub === "create" || sub === "edit"),
    )
    .map((args) => String(args.at(-1)));
}

/** @param {Ran} ran @returns {number} the sessions the run ran */
function sessions(ran) {
  return ran.calls.filter(({ kind }) => kind === "session").length;
}

const ready = await specWriter(READY);
const rerun = await specWriter({
  ...READY,
  start: { ...ready.saved, stage: "spec" },
});
const long = await specWriter({
  ...READY,
  replies: [replyOf({ files: FILES, spec: LONG_SPEC })],
});
const unready = {
  "needs-info": {
    fresh: await specWriter({
      replies: [NEEDS_INFO],
      code: CODE,
      wiki: WIKI,
      handoff: EARLIER,
    }),
    existing: await specWriter({
      replies: [NEEDS_INFO],
      code: CODE,
      wiki: WIKI,
      existing: true,
    }),
  },
  split: {
    fresh: await specWriter({
      replies: [SPLIT],
      code: CODE,
      wiki: WIKI,
      handoff: EARLIER,
    }),
    existing: await specWriter({
      replies: [SPLIT],
      code: CODE,
      wiki: WIKI,
      existing: true,
    }),
  },
  "no-work": {
    fresh: await specWriter({
      replies: [NO_WORK],
      code: PASSING,
      handoff: EARLIER,
    }),
    existing: await specWriter({
      replies: [NO_WORK],
      code: PASSING,
      existing: true,
    }),
  },
};
// The session commits nothing, and the test command would fail if it ran.
const noWorkUnchanged = await specWriter({
  replies: [NO_WORK],
  testCommand: "exit 1",
});
const noWorkFails = await specWriter({ replies: [NO_WORK], code: FAILING });
const wikiOnly = await specWriter({
  replies: [WIKI_ONLY],
  wiki: WIKI,
  start: { pr: EARLIER_PR },
});
const prFails = await specWriter({
  ...READY,
  ops: { "start-pr": () => ({ reply: { ok: false, error: "gh failed" } }) },
});
const gapTwice = await specWriter({ ...READY, replies: [GAP] });
const stacked = await specWriter({ ...READY, stacked: true });
// The session commits its spec draft too, and an earlier one left a handoff.
const DRAFT = ".issue-pipeline/spec-draft.md";
const drafted = await specWriter({
  ...READY,
  code: { ...CODE, [DRAFT]: "## Behaviour\n" },
  handoff: EARLIER,
});

test("a ready spec saves at implement with its PR, its tests' head and its interfaces", () => {
  const { end, saved, repo } = ready;
  const { specTestsSha, interfaces, noTestsReason } = saved;
  assert.deepEqual(end, { kind: "saved", stage: "implement" });
  assert.equal(saved.pr, PR);
  assert.equal(specTestsSha, refOf(repo.origin, BRANCH));
  assert.equal(saved.specWritesTests, true);
  assert.deepEqual(saved.files, FILES);
  assert.deepEqual(interfaces, [INTERFACE]);
  assert.equal(noTestsReason, null);
});

test("a ready spec posts one Spec comment and opens one draft PR that closes the issue", () => {
  assert.equal(specPosts(ready.writes), 1);
  assert.equal(countOf(ready.writes, "pr", "create"), 1);
  const [body = ""] = prBodies(ready.writes);
  assert.ok(body.startsWith("Closes #7"), body);
  assert.ok(body.includes("- It works."), body);
});

test("the spec's wiki edits are on the wiki's agent branch", () => {
  const { repo } = ready;
  assert.notEqual(refOf(repo.wikiOrigin, BRANCH), "");
});

test("a rerun sends start-pr the same body again and posts no second comment", () => {
  assert.deepEqual(rerun.end, { kind: "saved", stage: "implement" });
  assert.deepEqual(prBodies(rerun.writes), prBodies(ready.writes));
  assert.equal(specPosts(rerun.writes), 0);
});

test("a spec over the state's limit is saved to spec.md and clipped in the state", () => {
  assert.deepEqual(long.end, { kind: "saved", stage: "implement" });
  assert.ok(long.calls.some(({ name }) => name === "save-spec"));
  const { specFile, spec } = long.saved;
  assert.equal(specFile, SPEC_FILE);
  // The clipped spec ends with an ellipsis.
  assert.ok(String(spec).length <= SPEC_LIMIT + 1);
});

for (const [kind, { fresh, existing }] of Object.entries(unready)) {
  test(`${kind} deletes the branches it created and opens no PR`, () => {
    const { repo } = fresh;
    assert.equal(refOf(repo.origin, BRANCH), "");
    assert.equal(refOf(repo.wikiOrigin, BRANCH), "");
    assert.deepEqual(prBodies(fresh.writes), []);
  });

  test(`${kind} deletes the handoff an earlier session left`, () => {
    assert.equal(fs.existsSync(fresh.repo.handoffFile), false);
  });

  test(`${kind} resets branches that were there to their start heads`, () => {
    const { repo } = existing;
    assert.equal(refOf(repo.origin, BRANCH), repo.heads.code);
    assert.equal(refOf(repo.wikiOrigin, BRANCH), repo.heads.wiki);
    assert.deepEqual(prBodies(existing.writes), []);
  });

  // The remote refs above are read after the exit, so its push put nothing back.
  test(`${kind} resets the checkouts too, so the job's exit pushes nothing`, () => {
    assert.deepEqual(fresh.exit, { heads: fresh.repo.bases, pushes: 0 });
    assert.deepEqual(existing.exit, { heads: existing.repo.heads, pushes: 0 });
  });
}

test("no-work passes when the branch changes nothing, without running the tests", () => {
  assert.deepEqual(noWorkUnchanged.end, { kind: "stopped", code: "no-work" });
  assert.equal(sessions(noWorkUnchanged), 1);
});

test("no-work fails with the test command's output while a test fails, and the retry's failure stops the issue", () => {
  const { end, labels, tasks } = noWorkFails;
  const { stopReason } = noWorkFails.saved;
  assert.deepEqual(end, { kind: "stopped", code: "error" });
  assert.equal(stopReason, "the spec writer failed twice");
  assert.ok(!labels.includes("agent:stopped-no-work"), String(labels));
  assert.equal(tasks.length, 2);
  assert.ok(!String(tasks[0]).includes(FAILURE));
  assert.ok(String(tasks[1]).includes(FAILURE), tasks[1]);
  assert.equal(specPosts(noWorkFails.writes), 0);
  assert.deepEqual(prBodies(noWorkFails.writes), []);
});

test("needs-info, split and no-work end as their replies ask", () => {
  const asked = unready["needs-info"].fresh;
  const split = unready.split.fresh;
  const noWork = unready["no-work"].fresh;
  assert.ok(asked.labels.includes("agent:needs-info"));
  assert.equal(countOf(split.writes, "issue", "create"), 2);
  assert.ok(split.labels.includes("agent:split"));
  assert.deepEqual(noWork.end, { kind: "stopped", code: "no-work" });
});

test("a wiki-only spec closes the earlier PR and saves at review", () => {
  assert.deepEqual(wikiOnly.end, { kind: "saved", stage: "review" });
  const closes = wikiOnly.writes.filter(
    ([cmd, sub]) => cmd === "pr" && sub === "close",
  );
  assert.deepEqual(closes, [["pr", "close", String(EARLIER_PR)]]);
  assert.deepEqual(prBodies(wikiOnly.writes), []);
});

test("a failed start-pr stops the issue", () => {
  assert.deepEqual(prFails.end, { kind: "stopped", code: "error" });
});

test("a coverage gap twice stops the issue after two sessions with no spec", () => {
  const { stopReason } = gapTwice.saved;
  assert.deepEqual(gapTwice.end, { kind: "stopped", code: "error" });
  assert.equal(stopReason, "the spec writer failed twice");
  assert.equal(sessions(gapTwice), 2);
  assert.equal(specPosts(gapTwice.writes), 0);
  assert.deepEqual(prBodies(gapTwice.writes), []);
});

// The prerequisite's branch adds a file that is neither a test nor a stub, so
// a commit check against the base branch would fail the spec twice.
test("a stacked issue's spec starts from the prerequisite's branch", () => {
  assert.deepEqual(stacked.end, { kind: "saved", stage: "implement" });
});

test("a posted spec's draft is gone from the branch on origin, and so is the handoff", () => {
  const { end, repo, saved } = drafted;
  const { specTestsSha } = saved;
  assert.deepEqual(end, { kind: "saved", stage: "implement" });
  assert.notEqual(refOf(repo.origin, `${String(specTestsSha)}:${DRAFT}`), "");
  assert.equal(refOf(repo.origin, `${BRANCH}:${DRAFT}`), "");
  assert.notEqual(refOf(repo.origin, `${BRANCH}:test/quota.test.sh`), "");
  assert.equal(fs.existsSync(repo.handoffFile), false);
});
