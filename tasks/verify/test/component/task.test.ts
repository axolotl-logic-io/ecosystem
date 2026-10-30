import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@ecosystem/task-framework";
import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import { type VerifyCapabilities, verify } from "../../src/index.ts";
import type { PlannedReview } from "../../src/review.ts";

const SHA_LENGTH = 40;
const HEAD_MOVED = /head moved/u;
const AUTHOR = /author/u;
const HEAD = "a".repeat(SHA_LENGTH);
const MOVED = "b".repeat(SHA_LENGTH);
const CONTEXT: ExecutionContext = {
  execution: "attempt-1",
  signal: new AbortController().signal,
  checkCancelled: (): void => undefined,
  artifacts: { publish: (): Promise<void> => Promise.resolve() },
};
function pull(): PullRequest {
  return {
    number: 8,
    author: "writer",
    state: "OPEN",
    isDraft: true,
    head: "agent/issue-7",
    headSha: HEAD,
    base: "main",
    title: "Count",
    body: "Closes #7",
    reviews: [],
    threads: [],
    checks: [],
  };
}

const INPUTS = {
  issue: { repo: "example/widgets", number: 7 },
  account: "reviewer",
  baseBranch: "main",
  testCommand: "npm test",
  model: "provider/model",
  requireCi: false,
  ciWaitMinutes: 1,
};
function machine(): {
  capabilities: VerifyCapabilities;
  current: PullRequest;
  submitted: PlannedReview[];
  removed: () => boolean;
} {
  const current = pull();
  const submitted: PlannedReview[] = [];
  let removed = false;
  return {
    current,
    submitted,
    removed: (): boolean => removed,
    capabilities: {
      readPull: (): PullRequest => current,
      openCheckout: (head: string) => ({
        root: "/supplied",
        repo: "/supplied/repo",
        head,
        folder: "supplied",
      }),
      removeCheckout: (): void => {
        removed = true;
      },
      fullChecks: () => [],
      checkoutState: (): string => HEAD,
      baseCommit: (): string => "base",
      reviewSession: () =>
        Promise.resolve({ summary: "Reviewed", findings: [] }),
      commentable: () => new Map(),
      publishable: (text: string): string => text,
      submitReview: (
        _pull: number,
        _head: string,
        planned: PlannedReview,
      ): ReturnType<VerifyCapabilities["submitReview"]> => {
        submitted.push(planned);
        return { id: 1, state: "APPROVED" };
      },
      sleep: (): Promise<void> => unexpected("no pending CI"),
      checkStop: (): void => undefined,
      report: (): void => undefined,
    },
  };
}
test("a host can review a supplied checkout and submit an approval", async () => {
  const box = machine();
  assert.equal(
    (await verify.run(INPUTS, box.capabilities, CONTEXT)).status,
    "completed",
  );
  assert.equal(box.submitted[0]?.event, "APPROVE");
  assert.equal(box.removed(), true);
});
test("security findings block even when the model calls them nits", async () => {
  const box = machine();
  box.capabilities.reviewSession = (): ReturnType<
    VerifyCapabilities["reviewSession"]
  > =>
    Promise.resolve({
      summary: "Unsafe",
      findings: [
        { body: "Leaks credentials", severity: "nit", security: true },
      ],
    });
  await verify.run(INPUTS, box.capabilities, CONTEXT);
  assert.equal(box.submitted[0]?.event, "REQUEST_CHANGES");
  assert.equal(box.submitted[0]?.counts.security, true);
});
test("a moved head submits no stale review and retains its checkout", async () => {
  const box = machine();
  box.capabilities.reviewSession = (): ReturnType<
    VerifyCapabilities["reviewSession"]
  > => {
    box.current.headSha = MOVED;
    return Promise.resolve({ summary: "Reviewed", findings: [] });
  };
  await assert.rejects(
    verify.run(INPUTS, box.capabilities, CONTEXT),
    HEAD_MOVED,
  );
  assert.equal(box.submitted.length, 0);
  assert.equal(box.removed(), false);
});
test("an existing exact-head review returns no-change without a checkout", async () => {
  const box = machine();
  box.current.reviews.push({
    id: 1,
    author: "reviewer",
    state: "APPROVED",
    commit: HEAD,
    body: "Reviewed",
  });
  box.capabilities.openCheckout = (): ReturnType<
    VerifyCapabilities["openCheckout"]
  > => unexpected("review is already authoritative");
  assert.equal(
    (await verify.run(INPUTS, box.capabilities, CONTEXT)).status,
    "no-change",
  );
  assert.equal(box.submitted.length, 0);
});
test("a PR author cannot review their own work", async () => {
  const box = machine();
  box.current.author = "reviewer";
  box.capabilities.openCheckout = (): ReturnType<
    VerifyCapabilities["openCheckout"]
  > => unexpected("identity refused before checkout");
  await assert.rejects(verify.run(INPUTS, box.capabilities, CONTEXT), AUTHOR);
});

function unexpected(message: string): never {
  throw new Error(message);
}
