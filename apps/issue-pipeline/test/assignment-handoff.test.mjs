// @ts-check
import "./isolated-root-test-kit.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueLock } from "../src/assignment/exclusion.ts";
import { requestHandoff } from "../src/assignment/handoff.ts";
import { sweep } from "../src/assignment/worker.ts";
import { fakeGithub } from "./assignment/fake-github.mjs";
import { ready } from "./assignment/test-kit.mjs";
import { CODE, SHA_LENGTH } from "./assignment/world.mjs";

const SECOND = 1000;
const FIXTURE_4 = 4;
const EXPECTED_MESSAGE_1 = /fix the invariant/u;

test("developer saves a bound handoff and requests its reviewer; reviewer resumes without issue assignment or pending request", async () => {
  const fake = fakeGithub();
  let state = await ready(fake);
  assert.equal(state.coordination?.handoff?.phase, "requested");
  assert.equal(state.coordination?.handoff?.checkpoint.pr, state.pr);
  assert.equal(state.coordination?.handoff?.checkpoint.code, CODE);
  const requests = fake.writes.filter((write) =>
    write.endsWith("requested_reviewers"),
  ).length;
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(
    fake.writes.filter((write) => write.endsWith("requested_reviewers")).length,
    requests,
  );
  await sweep(fake.cfg, "check", fake.deps());
  state = fake.states.get(1) ?? state;
  assert.equal(state.coordination?.handoff?.phase, "accepted");
  assert.equal(state.stage, "merge");
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.refs.has(issueLock(1)), false);
  assert.equal(fake.launches.at(-1)?.stage, "review");
  const pr = fake.prs.get(state.pr ?? 0);
  assert.ok(pr);
  fake.clearRequest(pr.number);
  fake.review(pr.number, "APPROVED");
  fake.request(pr.number, "merger", "review_request_removed");
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.states.get(1)?.stage, "done");
  assert.deepEqual(
    fake.launches.map((job) => job.stage),
    ["author", "implement", "review", "merge"],
  );
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.launches.length, FIXTURE_4);
});

test("a lost handoff-request response leaves a visible intent and can be reconciled without a duplicate request", async () => {
  const fake = fakeGithub();
  fake.issue(1);
  await sweep(fake.cfg, "build", fake.deps());
  fake.world.now += SECOND;
  fake.world.failRequest = true;
  await sweep(fake.cfg, "build", fake.deps());
  const state = fake.states.get(1);
  assert.ok(state);
  assert.equal(state.coordination?.handoff?.phase, "pending");
  assert.equal(state.coordination?.pending?.kind, "review-request");
  assert.ok(fake.refs.has(issueLock(1)));
  const before = fake.writes.filter((write) =>
    write.endsWith("requested_reviewers"),
  ).length;
  const row = fake.issues.get(1);
  assert.ok(row);
  requestHandoff(fake.cfg, fake.deps(), row, state);
  assert.equal(fake.states.get(1)?.coordination?.handoff?.phase, "requested");
  assert.equal(fake.states.get(1)?.coordination?.pending, null);
  assert.equal(
    fake.writes.filter((write) => write.endsWith("requested_reviewers")).length,
    before,
  );
});

test("authenticated exact-head change requests invalidate review authority and return operational feedback to development", async () => {
  const fake = fakeGithub();
  const state = await ready(fake);
  const pr = state.pr ?? 0;
  fake.review(pr, "CHANGES_REQUESTED", { body: "fix the invariant" });
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.launches.length, 2);
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.launches.at(-1)?.stage, "implement");
  assert.match(fake.notices.get(1) ?? "", EXPECTED_MESSAGE_1);
  assert.notEqual(
    fake.states.get(1)?.coordination?.handoff?.id,
    state.coordination?.handoff?.id,
  );
});

test("untrusted requests, cancellation, external heads and changed trusted inputs cannot authorize hardening", async () => {
  for await (const reason of ["actor", "cancel", "head", "inputs"]) {
    const fake = fakeGithub();
    const state = await ready(fake);
    const pr = state.pr ?? 0;
    const pull = fake.prs.get(pr);
    assert.ok(pull);
    if (reason === "actor") {
      fake.request(pr, "visitor");
    }
    if (reason === "cancel") {
      fake.request(pr, "visitor", "review_request_removed");
    }
    if (reason === "head") {
      pull.head.sha = "d".repeat(SHA_LENGTH);
    }
    if (reason === "inputs") {
      fake.world.inputs = "changed human input";
    }
    await sweep(fake.cfg, "check", fake.deps());
    assert.equal(fake.launches.length, 2, reason);
    assert.ok(fake.notices.get(1), reason);
  }
});

test("same-second authenticated development reassignment invalidates a consumed handoff before merge", async () => {
  const fake = fakeGithub();
  const before = await ready(fake);
  await sweep(fake.cfg, "check", fake.deps());
  fake.issue(1);
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.launches.at(-1)?.stage, "review");
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.launches.at(-1)?.stage, "implement");
  assert.notEqual(
    fake.states.get(1)?.coordination?.handoff?.id,
    before.coordination?.handoff?.id,
  );
});

test("consumption is not permission to ignore a later request cancellation by another actor", async () => {
  const fake = fakeGithub();
  const state = await ready(fake);
  await sweep(fake.cfg, "check", fake.deps());
  fake.review(state.pr ?? 0, "APPROVED");
  fake.request(state.pr ?? 0, "alice", "review_request_removed");
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.launches.at(-1)?.stage, "review");
  assert.ok(fake.notices.get(1));
});
