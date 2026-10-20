// @ts-check
import "./isolated-root-test-kit.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExecution } from "../src/assignment/authority.ts";
import {
  acquire,
  integrationLock,
  issueLock,
} from "../src/assignment/exclusion.ts";
import { sweep } from "../src/assignment/worker.ts";
import { fakeGithub } from "./assignment/fake-github.mjs";
import { ready } from "./assignment/test-kit.mjs";
import { SHA_LENGTH } from "./assignment/world.mjs";
import { waitFor } from "./bounded-test-kit.mjs";

const DAY = 86_400_000;
const EXPECTED_MESSAGE_1 = /ownership lost/u;
const EXPECTED_MESSAGE_2 = /withdrawn/u;
const EXPECTED_MESSAGE_3 = /closed/u;
const EXPECTED_MESSAGE_4 = /withdrawn/u;
const EXPECTED_MESSAGE_5 = /integration turn/u;

test("duplicate instances sharing a logical worker cannot launch concurrent role sessions", async () => {
  const fake = fakeGithub();
  fake.issue(1);
  /** @type {PromiseWithResolvers<void>} */
  const pause = Promise.withResolvers();
  const { model } = fake.callbacks;
  fake.callbacks.model = async (execution) => {
    await pause.promise;
    return await model(execution);
  };
  const first = sweep(fake.cfg, "build", fake.deps());
  try {
    await waitFor(
      "exclusive fake model session",
      () => fake.launches.length === 1,
    );
    await sweep(fake.cfg, "build", fake.deps());
    assert.equal(fake.launches.length, 1);
    assert.ok(fake.refs.has(issueLock(1)));
  } finally {
    pause.resolve();
    await first;
  }
  assert.equal(fake.refs.has(issueLock(1)), false);
});

test("stale leases alone cannot take over an executor; old instances refuse writes after explicit ownership loss or withdrawal", async () => {
  const fake = fakeGithub();
  fake.issue(1);
  const token = acquire(fake.hub, fake.cfg, issueLock(1), "build");
  assert.ok(token);
  fake.world.now += DAY;
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.launches.length, 0);
  const execution = {
    worker: "build",
    issue: 1,
    stage: /** @type {const} */ ("author"),
    token,
    turn: null,
    handoff: null,
  };
  assertExecution({ ...fake.cfg, execution }, 1, true, fake.hub);
  fake.refs.set(issueLock(1), "d".repeat(SHA_LENGTH));
  assert.throws(
    () => assertExecution({ ...fake.cfg, execution }, 1, true, fake.hub),
    EXPECTED_MESSAGE_1,
  );
  fake.refs.set(issueLock(1), token);
  const issue = fake.issues.get(1);
  assert.ok(issue);
  issue.assignees = [];
  assert.throws(
    () => assertExecution({ ...fake.cfg, execution }, 1, true, fake.hub),
    EXPECTED_MESSAGE_2,
  );
  issue.assignees = [{ login: "builder" }];
  issue.state = "closed";
  assert.throws(
    () => assertExecution({ ...fake.cfg, execution }, 1, true, fake.hub),
    EXPECTED_MESSAGE_3,
  );
  assert.throws(
    () =>
      assertExecution(
        { ...fake.cfg, assignment: undefined, execution },
        1,
        true,
        fake.hub,
      ),
    EXPECTED_MESSAGE_4,
  );
});

test("repository integration turns survive restart and block a distinct issue without consuming its handoff", async () => {
  const fake = fakeGithub();
  await ready(fake);
  await sweep(fake.cfg, "check", fake.deps());
  const turn = acquire(
    fake.hub,
    fake.cfg,
    integrationLock(fake.cfg.baseBranch),
    "another instance",
  );
  assert.ok(turn);
  await sweep(fake.cfg, "check", fake.deps());
  assert.equal(fake.launches.at(-1)?.stage, "review");
  assert.equal(fake.refs.has(issueLock(1)), false);
  assert.match(fake.notices.get(1) ?? "", EXPECTED_MESSAGE_5);
  assert.equal(fake.states.get(1)?.coordination?.handoff?.phase, "accepted");
});

test("fresh requirements reauthor before more implementation while local-only or uncertain outcomes retain their fence", async () => {
  const fake = fakeGithub();
  fake.issue(1);
  await sweep(fake.cfg, "build", fake.deps());
  fake.world.inputs = "new human inputs";
  await sweep(fake.cfg, "build", fake.deps());
  assert.deepEqual(
    fake.launches.map((job) => job.stage),
    ["author", "author"],
  );
  const { model } = fake.callbacks;
  fake.callbacks.model = async (execution) => {
    const result = await model(execution);
    return { ...result, localRecovery: true };
  };
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.states.get(1)?.coordination?.localRecovery, true);
  assert.ok(fake.refs.has(issueLock(1)));
  const count = fake.launches.length;
  await sweep(fake.cfg, "build", fake.deps());
  assert.equal(fake.launches.length, count);
});
