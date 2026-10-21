// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  calls,
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import { BASE, git, PR, world } from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const REFUSED = z.looseObject({ merged: z.literal(false), reason: z.string() });
const SHA_LENGTH = 40;
const WRONG_RECEIPT =
  /differs|not the configured repository|not agent|same source/u;
const READ_DENIED = /permission denied/u;
const LANDED = /may already have landed/u;
const ANCESTRY = /target does not equal/u;

/** @returns {string[][]} */
function mutations() {
  return calls().filter((args) => args[0] === "git" && args.includes("push"));
}

for (const outcome of [
  "lease mismatch",
  "permission denied",
  "missing target",
  "branch protection",
  "non-fast-forward",
  "connection lost before send",
  "timeout before receive",
  "unknown response",
]) {
  test(`${outcome} has no new own receipt and never retries mutation`, () => {
    const w = world({ fastForward: true });
    script(w, [
      ...prechecks(w),
      post(w, { skipMutation: true, code: 1, stderr: outcome }),
    ]);
    const reply = REFUSED.parse(merge(w.cfg, request(w), confirmationClock()));
    assert.match(reply.reason, LANDED);
    assert.match(reply.reason, ANCESTRY);
    assert.equal(mutations().length, 1);
    assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
    consumed();
  });
}

for (const body of ["", "not JSON", '{"sha":""}', '{"sha":"integration"}']) {
  test(`acknowledgement text ${JSON.stringify(body)} cannot replace exact-target confirmation`, () => {
    const w = world({ fastForward: true });
    script(w, [...prechecks(w), post(w, { skipMutation: true, stdout: body })]);
    assert.match(
      REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
      ANCESTRY,
    );
    assert.equal(mutations().length, 1);
    assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
    consumed();
  });
}

for (const extra of [
  { state: "CLOSED" },
  { mergeCommit: { oid: "f".repeat(SHA_LENGTH) } },
  { headRefOid: "d".repeat(SHA_LENGTH) },
  { number: PR + 1 },
  { isCrossRepository: true },
  { headRefName: "other" },
]) {
  test(`FF confirmation requires genuine same-PR retained-head binding: ${JSON.stringify(extra)}`, () => {
    const w = world({ fastForward: true });
    script(w, [
      ...prechecks(w),
      post(w),
      ...Array.from({ length: 3 }, () =>
        prStep(w, { ...mergedView(w), ...extra }),
      ),
    ]);
    assert.match(
      REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
      WRONG_RECEIPT,
    );
    assert.equal(mutations().length, 1);
    consumed();
  });
}

test("unreadable post-request metadata stops after one mutation", () => {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w),
    ...Array.from({ length: 3 }, () => ({
      ...prStep(w),
      code: 1,
      stderr: "permission denied",
    })),
  ]);
  assert.match(
    REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
    READ_DENIED,
  );
  assert.equal(mutations().length, 1);
  consumed();
});

test("matching result must equal the freshly read literal integration target", () => {
  const w = world({ fastForward: true });
  script(w, [...prechecks(w), post(w, { skipMutation: true })]);
  assert.match(
    REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
    ANCESTRY,
  );
  assert.equal(mutations().length, 1);
  consumed();
});

test("exhausted transient post-request reads become a stop reply, never a deferred mutation retry", () => {
  const w = world({ fastForward: true });
  const unreadable = {
    ...prStep(w),
    code: 1,
    stderr: "HTTP 503 Service Unavailable",
  };
  script(w, [...prechecks(w), post(w), unreadable, unreadable, unreadable]);
  const reply = REFUSED.parse(merge(w.cfg, request(w), confirmationClock()));
  assert.ok(reply.reason.includes("bounded merge recovery"));
  assert.equal(mutations().length, 1);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.merged);
  consumed();
});
