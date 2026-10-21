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
  /not genuinely MERGED|differs|not the configured repository|not agent|same source/u;
const READ_DENIED = /permission denied/u;
const LANDED = /may already have landed/u;
const ANCESTRY = /not on origin\/integration/u;

/** @returns {string[][]} */
function mutations() {
  return calls().filter(
    (args) => args.includes("POST") && !args.includes("event=APPROVE"),
  );
}

for (const { status, outcome } of [
  { status: "204", outcome: "already merged" },
  { status: "403", outcome: "rejected" },
  { status: "404", outcome: "rejected" },
  { status: "409", outcome: "rejected" },
  { status: "422", outcome: "rejected" },
  { status: "500", outcome: "unconfirmed" },
  { status: "lost", outcome: "unconfirmed" },
  { status: "timeout", outcome: "unconfirmed" },
]) {
  test(`HTTP ${status} has no new own receipt and never retries mutation`, () => {
    const w = world();
    let stdout = `HTTP/2.0 ${status} Outcome\r\n\r\n`;
    let code = 1;
    if (status === "204") {
      code = 0;
    }
    if (status === "lost" || status === "timeout") {
      stdout = "";
    }
    script(w, [
      ...prechecks(w),
      post(w, {
        stdout,
        code,
        stderr: "i/o timeout or connection lost",
        updates: [],
      }),
    ]);
    const reply = merge(w.cfg, request(w), confirmationClock());
    assert.equal(reply.merged, false);
    assert.ok("reason" in reply && reply.reason.includes(outcome));
    assert.ok(
      "reason" in reply &&
        reply.reason.includes("code may already have landed"),
    );
    assert.equal(mutations().length, 1);
    assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
    consumed();
  });
}

for (const body of ["", "not JSON", '{"sha":""}', '{"sha":"integration"}']) {
  test(`malformed 201 body ${JSON.stringify(body)} stops without retry or own receipt`, () => {
    const w = world();
    script(w, [
      ...prechecks(w),
      post(w, { stdout: `HTTP/2.0 201 Created\n\n${body}` }),
    ]);
    assert.match(
      REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
      LANDED,
    );
    assert.equal(mutations().length, 1);
    consumed();
  });
}

for (const extra of [
  { state: "OPEN" },
  { state: "CLOSED" },
  { mergeCommit: { oid: "f".repeat(SHA_LENGTH) } },
  { headRefOid: "d".repeat(SHA_LENGTH) },
  { number: PR + 1 },
  { isCrossRepository: true },
  { headRefName: "other" },
]) {
  test(`201 requires genuine same-PR retained-head result: ${JSON.stringify(extra)}`, () => {
    const w = world();
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
  const w = world();
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

test("matching result must be in freshly fetched integration", () => {
  const w = world();
  script(w, [
    ...prechecks(w),
    post(w, { updates: [] }),
    ...Array.from({ length: 3 }, () => [
      prStep(w, mergedView(w)),
      prStep(w, mergedView(w), true),
    ]).flat(),
  ]);
  assert.match(
    REFUSED.parse(merge(w.cfg, request(w), confirmationClock())).reason,
    ANCESTRY,
  );
  assert.equal(mutations().length, 1);
  consumed();
});

test("exhausted transient post-request reads become a stop reply, never a deferred mutation retry", () => {
  const w = world();
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
