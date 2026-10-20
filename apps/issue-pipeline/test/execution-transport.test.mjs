// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { coordination } from "../src/coordination.ts";
import {
  executionIdentity,
  integrationTurn,
  issueExecution,
  withExecution,
} from "../src/execution.ts";
import { ghIsRead } from "../src/github.ts";
import { world } from "./coordination-test-kit.mjs";
import { commentLines, installFakeGh } from "./fake-gh.mjs";

const fake = installFakeGh();
const HELD = /reconciliation|provenance/u;
/** @param {ReturnType<typeof world>} github */
function serve(github) {
  fake.reply([
    {
      when: "comments?per_page=100",
      stdout: commentLines(github.comments),
      keep: true,
    },
    ...[...github.locks].map(([ref, sha]) => ({
      when: `/git/ref/${ref}`,
      stdout: JSON.stringify({ ref: `refs/${ref}`, object: { sha } }),
      keep: true,
    })),
  ]);
}

/** @param {ReturnType<typeof world>} github @param {number} issue @param {string} lane */
function seedIssue(github, issue, lane) {
  const identity = executionIdentity(github.cfg, issue, lane);
  const scope = JSON.stringify([
    github.cfg.repo,
    github.cfg.baseBranch,
    "issue",
    issue,
    identity.branch,
  ]);
  const guard = coordination(github.cfg, github.port, scope, identity);
  guard.request();
  return {
    cfg: withExecution(github.cfg, identity),
    acquired: guard.acquire(),
  };
}

test("fresh integration factories reconstruct repository/base order across issues through authenticated GitHub reads", () => {
  const github = world();
  const first = seedIssue(github, github.issue, "caller");
  const second = seedIssue(github, github.issue + 1, "other");
  assert.equal(first.acquired, true);
  assert.equal(second.acquired, true);
  const a = first.cfg;
  const b = second.cfg;
  const scope = JSON.stringify([
    github.cfg.repo,
    github.cfg.baseBranch,
    "integration",
  ]);
  assert.ok(a.execution);
  assert.ok(b.execution);
  const turnA = coordination(github.cfg, github.port, scope, a.execution);
  const turnB = coordination(github.cfg, github.port, scope, b.execution);
  turnA.request();
  turnB.request();
  assert.equal(turnA.acquire(), true);
  serve(github);
  issueExecution(a, github.issue).assertOwner();
  issueExecution(b, github.issue + 1).assertOwner();
  const reconstructed = integrationTurn(b, github.issue + 1);
  assert.deepEqual(reconstructed.read(), turnA.read());
  assert.deepEqual(
    reconstructed.read().pending.map((request) => request.identity),
    [a.execution, b.execution],
  );
  assert.equal(reconstructed.acquire(), false);
  assert.throws(() => reconstructed.save({ stale: true }), HELD);
  assert.throws(() => reconstructed.release(), HELD);
  integrationTurn(a, github.issue).assertOwner();
  assert.equal(fake.writes(ghIsRead).length, 0);
  assert.ok(
    fake.authenticatedCalls().every((call) => call.identity === "merge"),
  );
});

test("a previously valid factory cannot use a REST body when same-read editor provenance is invalid", () => {
  const github = world();
  const seeded = seedIssue(github, github.issue, "caller");
  assert.equal(seeded.acquired, true);
  const { cfg } = seeded;
  serve(github);
  const guard = issueExecution(cfg, github.issue);
  guard.assertOwner();
  const latest = github.comments.at(-1);
  assert.ok(latest);
  latest.lastEditedAt = "2026-10-20T00:00:00Z";
  latest.editor = { login: "visitor" };
  serve(github);
  assert.throws(() => guard.assertOwner(), HELD);
  assert.throws(() => guard.save({ stage: "done" }), HELD);
  assert.equal(fake.writes(ghIsRead).length, 0);
});
