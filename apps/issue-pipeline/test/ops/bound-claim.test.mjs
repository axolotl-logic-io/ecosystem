// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { effectNames, effectsOf } from "../gh-effects-test-kit.mjs";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { root, runDir, sh, timeless, worktree } from "../ops-cli-test-kit.mjs";
import { prView } from "../ops-v2-test-kit.mjs";
import { boundFixture } from "./bound-claim-test-kit.mjs";

const HELD = /unreleased|fresh execution|ownership|reconcil/u;
const PR = 90;
const FRESH = 501;
const ANSWERED = 502;
const RESUME = 503;
const REFUSED = 510;
const OLD = "2000-01-01T00:00:00Z";

// Five migrated outcomes use the bound seam; legacy CLI cases remain compatibility.
test("fresh bound work checkpoints a receipt, prepares its branch and runs setup", () => {
  const f = boundFixture(FRESH);
  const got = f.claimBound();
  assert.ok("state" in got);
  assert.equal(got.claim.posted, true);
  assert.equal(got.claim.id, got.state.execution?.request);
  assert.equal(got.state.stage, "implement");
  assert.equal(got.state.branch, "agent/issue-501");
  assert.equal(got.state.execution?.instance, f.cfg.execution?.instance);
  assert.equal(got.remoteHead, null);
  assert.equal(fs.existsSync(path.join(worktree(f.issue), "setup-ran")), true);
  assert.equal(
    fs.existsSync(path.join(runDir(f.issue), "setup-at-claim.log")),
    true,
  );
  assert.equal(
    sh(`git -C ${worktree(f.issue)} branch --show-current`),
    got.state.branch,
  );
  assert.deepEqual(f.read(), got.state);
  const names = effectNames(effectsOf(f.normalizedWrites()));
  assert.deepEqual(
    names.filter(
      (name) => name.startsWith("label ") || name.startsWith("unlabel "),
    ),
    ["label #501 agent:working", "unlabel #501 agent:needs-info"],
  );
  assert.ok(f.calls().every((call) => call.identity === "merge"));
});

test("answered resume forwards queued PR metadata and retains draft and assigned head", () => {
  const f = boundFixture(ANSWERED, {
    replies: [
      prView(ANSWERED, PR),
      { when: `issue edit ${PR} `, keep: true },
      { when: `issue view ${PR} `, stdout: "[]", keep: true },
    ],
  });
  const state = f.claim();
  const head = sh(`git -C ${root}/seed rev-parse HEAD`);
  sh(
    `git --git-dir=${root}/origin.git update-ref refs/heads/agent/issue-502 ${head}`,
  );
  // Replace just the queued PR response, preserving authenticated transport state.
  f.queue([
    { when: "collaborators/alice", stdout: "", keep: true },
    {
      when: "api repos/o/r/issues/502",
      stdout: JSON.stringify({
        title: "Answered",
        body: "answer",
        state: "open",
        labels: [{ name: "agent:needs-info" }],
        user: { login: "alice" },
      }),
      keep: true,
    },
    prView(ANSWERED, PR, { headRefOid: head }),
    ...claimMutationReplies(ANSWERED, ANSWERED, PR),
    { when: `issue view ${PR} `, stdout: "[]", keep: true },
  ]);
  const saved = f.save({
    ...state,
    asked: { inputs: "old-inputs" },
    pr: PR,
    headSha: head,
  });
  f.guard().release();
  const next = f.next();
  const got = f.claimBound(next);
  assert.ok("state" in got);
  assert.equal(got.state.pr, PR);
  assert.equal(got.remoteHead, head);
  assert.equal(got.state.headSha, head);
  assert.deepEqual(got.state.asked, saved.asked);
  assert.notDeepEqual(got.state.execution, saved.execution);
  assert.equal(got.state.branch, saved.branch);
  assert.equal(
    f
      .transport()
      .comments.filter((comment) =>
        comment.body.includes("agent-pipeline:state"),
      ).length,
    1,
  );
  const names = effectNames(effectsOf(f.normalizedWrites()));
  assert.ok(names.includes("label #90 agent:working"));
  assert.ok(names.includes("unlabel #502 agent:needs-info"));
});

for (const stopped of [false, true]) {
  test(`released ${String(stopped)} resume preserves worktree and logs with fresh ownership`, () => {
    const issue = RESUME + Number(stopped);
    const f = boundFixture(issue);
    const state = f.claim();
    sh(
      `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${issue} ${worktree(issue)} origin/integration`,
    );
    fs.writeFileSync(path.join(worktree(issue), "wip"), "retained");
    let saved = { ...state, lease: { lane: "old", sweepId: "old", at: OLD } };
    if (stopped) {
      saved = {
        ...saved,
        stage: "stopped",
        stoppedStage: "implement",
        stopCode: "conflict",
        counts: { syncs: 2, conflictFixes: 1 },
        review: { ...state.review, round: 3 },
        log: [`${OLD} stopped (conflict): retained`],
      };
    }
    f.save(saved);
    f.guard().release();
    const got = f.claimBound(f.next("different"));
    assert.ok("state" in got);
    assert.equal(got.state.stage, "implement");
    assert.deepEqual(got.state.counts, { syncs: 0, conflictFixes: 0 });
    assert.equal(got.state.review.round, 0);
    assert.equal(got.state.stopCode, null);
    assert.deepEqual(got.state.log.map(timeless), saved.log.map(timeless));
    assert.notDeepEqual(got.state.execution, state.execution);
    assert.equal(
      fs.readFileSync(path.join(worktree(issue), "wip"), "utf8"),
      "retained",
    );
    assert.equal(fs.existsSync(path.join(worktree(issue), "setup-ran")), false);
  });
}

for (const lane of ["stable", "different"]) {
  for (const at of [OLD, "2099-01-01T00:00:00Z"]) {
    test(`unreleased ${lane} owner refuses lease ${at} without mutation or setup`, () => {
      const f = boundFixture(REFUSED);
      const state = f.claim();
      f.save({ ...state, lease: { lane: "stable", sweepId: "old", at } });
      const before = f.transport();
      const writes = f.writes();
      assert.throws(() => f.claimBound(f.next(lane)), HELD);
      assert.throws(() => f.claimBound(), HELD);
      assert.deepEqual(f.transport(), before);
      assert.deepEqual(f.writes(), writes);
      assert.equal(fs.existsSync(worktree(f.issue)), false);
    });
  }
}
