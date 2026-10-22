// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  calls,
  consumed,
  post,
  prechecks,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import {
  BASE,
  git,
  ISSUE,
  PR,
  world,
} from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import { confirmation, posts } from "./explicit-target-recovery-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const { beginMerge } = await import("../../src/ops/merge-attempt.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const { readWriteAuthority } = await import("../../src/write-authority.ts");
const NO_RETRY = /may already have landed.*not authorized/u;

test("a real receive-pack rejection permanently closes automatic retry even after the rejection is removed", () => {
  const w = world({ fastForward: true });
  const hook = path.join(w.origin, "hooks", "pre-receive");
  const received = path.join(w.place, "received");
  fs.writeFileSync(hook, `#!/bin/sh\ncat >> '${received}'\nexit 1\n`, {
    mode: 0o755,
  });
  script(w, [...prechecks(w), post(w)]);
  const first = merge(w.cfg, request(w), confirmationClock());
  assert.ok(!first.merged);
  assert.match(first.reason, NO_RETRY);
  assert.equal(
    fs.readFileSync(received, "utf8"),
    `${w.base} ${w.head} refs/heads/${BASE}\n`,
  );
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  const armed = readWriteState(w.cfg, ISSUE);
  assert.equal(armed.mergeAttempt?.result, null);
  assert.deepEqual(armed.mergeAttempt?.operation, {
    kind: "fast-forward",
    base: w.base,
  });
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  consumed();
  fs.rmSync(hook);
  script(w, [], true);
  const replay = merge(w.cfg, request(w), confirmationClock());
  assert.ok(!replay.merged);
  assert.match(replay.reason, NO_RETRY);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(posts().length, 1);
  assert.equal(
    calls().filter((args) => args.includes("event=APPROVE")).length,
    1,
  );
  assert.deepEqual(
    readWriteState(w.cfg, ISSUE).mergeAttempt?.operation,
    armed.mergeAttempt?.operation,
  );
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  consumed();
});

test("interruption after arming but before sending cannot rearm; later exact evidence reconciles read-only", () => {
  const w = world({ fastForward: true });
  script(w, []);
  beginMerge(w.cfg, ISSUE, PR, { authorized: w.revision, base: w.base });
  const intent = readWriteState(w.cfg, ISSUE).mergeAttempt;
  const refused = merge(w.cfg, request(w), confirmationClock());
  assert.ok(!refused.merged);
  assert.match(refused.reason, NO_RETRY);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(posts().length, 0);
  consumed();
  git(w.origin, ["update-ref", `refs/heads/${BASE}`, w.head]);
  script(w, confirmation(w), true);
  assert.deepEqual(merge(w.cfg, request(w), confirmationClock()), {
    merged: true,
    mergeCommit: w.head,
    headSha: w.head,
  });
  const saved = readWriteState(w.cfg, ISSUE);
  assert.deepEqual(saved.mergeAttempt?.operation, intent?.operation);
  assert.deepEqual(saved.mergeAttempt?.authorized, intent?.authorized);
  assert.equal(saved.mergeAttempt?.result, null);
  assert.equal(saved.merged?.code, w.head);
  assert.equal(saved.hardenedTarget?.sha, w.base);
  assert.equal(readWriteAuthority(w.cfg, ISSUE).codeWritable, false);
  assert.equal(posts().length, 0);
  assert.equal(
    calls().some((args) => args.includes("event=APPROVE")),
    false,
  );
  consumed();
});
