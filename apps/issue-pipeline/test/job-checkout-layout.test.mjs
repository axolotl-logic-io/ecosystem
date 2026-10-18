// @ts-check
// A stage job's folder holds its code checkout, repo/, and its wiki
// checkout, docs/, side by side (separate-checkouts, #338); every stage gets
// docs/ (every-role-reads-wiki), and teardown finds the work left in either
// (Running-the-Issue-Pipeline, "Stage jobs").
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { checkoutOf, docsOf, repoOf } from "./job-git-test-kit.mjs";
import {
  logOf,
  piCommands,
  piStarts,
  READY_SPEC,
  repliesAt,
  runJob,
  SPEC_SESSION,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const ISSUE = 7;
// A session that waits until it is stopped.
const WAITING = { events: [messageEnd(USAGE), "wait", outputEnd(READY_SPEC)] };
// The structured output of a triage agent that finds the issue ready.
const READY_TRIAGE = {
  decision: "ready",
  reason: "Small.",
  questions: [],
  plan: "Change src/a.ts and test it.",
};
const EXIT_PUSH = { "exit-push": { ok: true } };

/** @param {Place} place @returns {boolean} whether a launch spent tokens */
function spent(place) {
  const launches = statusOf(place)?.launches ?? [];
  return launches.some((/** @type {any} */ launch) => launch.usage.input > 0);
}

/** @param {Place} place @returns {any[]} the exit-push requests */
function pushes(place) {
  return logOf(place, "ops.log").filter(({ op }) => op === "exit-push");
}

for (const stage of ["spec", "implement"]) {
  test(`the ${stage} job's folder holds repo/ and docs/ side by side, and is its session's cwd`, async () => {
    const place = setUp(repliesAt(stage), WAITING, {}, { wiki: true });
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

test("a triage job gets docs/ to read, and its edits there are lost as docs/ paths", () => {
  const place = setUp(
    repliesAt("triage"),
    {
      untracked: "docs/Page.md",
      events: [messageEnd(USAGE), outputEnd(READY_TRIAGE)],
    },
    {},
    { wiki: true },
  );
  const r = runJob(place, ["--stage", "triage"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusOf(place).lostChanges, ["docs/Page.md"]);
  assert.equal(fs.existsSync(checkoutOf(place.root, "triage")), false);
});

test("a spec job whose only commit is in docs/ still runs its exit push", () => {
  const place = setUp(
    { ...repliesAt("spec"), ...EXIT_PUSH },
    { ...SPEC_SESSION, commit: "docs/Page.md" },
    {},
    { wiki: true },
  );
  const r = runJob(place, ["--stage", "spec"]);
  assert.equal(r.status, 0, r.stderr);
  const [push] = pushes(place);
  assert.deepEqual(push?.checkout, {
    issue: ISSUE,
    dir: repoOf(place.root, "spec"),
  });
  assert.deepEqual(statusOf(place).lostChanges, []);
});

// A writer session's pipeline_commit routes repo/ and docs/ pathspecs from
// its scope's root, so the root must be the job's folder (#338).
const SCOPES = [
  { wiki: true, docs: { dir: "docs", access: "read" }, name: "with" },
  { wiki: false, docs: null, name: "without" },
];
for (const { wiki, docs, name } of SCOPES) {
  test(`an implement job ${name} a wiki gives its writer session the commit scope of its folder`, () => {
    const place = setUp(repliesAt("implement"), SPEC_SESSION, {}, { wiki });
    const r = runJob(place, ["--stage", "implement"]);
    assert.equal(r.status, 0, r.stderr);
    const [start] = piStarts(place);
    const scope = start.commitScope;
    assert.equal(scope.root, checkoutOf(place.root, "implement"));
    assert.deepEqual(scope.repo, { dir: "repo", access: "write" });
    assert.deepEqual(scope.docs, docs);
  });
}

// The facts the preamble promises a stage job's session (#338): its folder,
// repo/ on the issue's branch, and docs/ with the stage's access. The
// checkouts' own paths come from the claim, which the fake ops answers.
const PREAMBLES = [
  // A stage the sweep runs.
  {
    stage: "implement",
    script: SPEC_SESSION,
    access: "read access",
    facts: ["`git -C repo add -A`"],
  },
  // The registered role that writes the wiki.
  {
    stage: "spec",
    script: SPEC_SESSION,
    access: "write access",
    facts: [],
  },
  // A stage that runs a registered role.
  {
    stage: "triage",
    script: { events: [messageEnd(USAGE), outputEnd(READY_TRIAGE)] },
    access: "read access",
    facts: [],
  },
];
for (const { stage, script, access, facts } of PREAMBLES) {
  test(`the ${stage} job's session is told its folder, repo/ and docs/ with ${access}`, () => {
    const place = setUp(repliesAt(stage), script, {}, { wiki: true });
    const r = runJob(place, ["--stage", stage]);
    assert.equal(r.status, 0, r.stderr);
    const prompt = piCommands(place).find(({ type }) => type === "prompt");
    const text = String(prompt?.message);
    const root = checkoutOf(place.root, stage);
    for (const fact of [
      `Working directory: ${root},`,
      "`repo/` (",
      "is the code checkout",
      `agent/issue-${ISSUE}`,
      "`docs/` (",
      "wiki checkout",
      access,
      ...facts,
    ]) {
      assert.ok(text.includes(fact), `${fact} missing from:\n${text}`);
    }
  });
}
