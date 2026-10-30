import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@ecosystem/task-framework";
import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import { type FixCapabilities, fix } from "../../src/index.ts";

const SHA_LENGTH = 40;
const HEAD = "a".repeat(SHA_LENGTH);
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

const ROUND_LIMIT = 3;
const INPUTS = {
  issue: { repo: "example/widgets", number: 7 },
  account: "writer",
  verifyAccount: "reviewer",
  testCommand: "npm test",
  model: "provider/model",
};
function machine(): {
  capabilities: FixCapabilities;
  current: PullRequest;
  pushes: () => number;
  removed: () => boolean;
} {
  const current = pull();
  const pushedHeads: string[] = [];
  let removed = false;
  return {
    current,
    pushes: (): number => pushedHeads.length,
    removed: (): boolean => removed,
    capabilities: {
      github: {
        issue: INPUTS.issue,
        account: "writer",
        readJson: (): unknown => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
        issueNow: () => ({
          number: 7,
          title: "Count",
          body: "Count widgets",
          author: "reviewer",
          state: "open",
          labels: [],
        }),
        comments: () => [],
        reply: (): void => unexpected("no unanswered threads"),
      },
      readPull: (): PullRequest => current,
      openWriter: () => ({
        directory: "/supplied/repo",
        conflicts: [],
        push: (): string => {
          pushedHeads.push(HEAD);
          return HEAD;
        },
        session: (): Promise<unknown> => unexpected("no blocking work"),
        remove: (): void => {
          removed = true;
        },
      }),
      checkStop: (): void => undefined,
      report: (): void => undefined,
    },
  };
}
test("a supplied writer merges the base and publishes without a model when no findings remain", async () => {
  const box = machine();
  assert.equal(
    (await fix.run(INPUTS, box.capabilities, CONTEXT)).status,
    "no-change",
  );
  assert.equal(box.pushes(), 1);
  assert.equal(box.removed(), true);
});
test("a missing PR is a blocked prerequisite without opening work", async () => {
  const box = machine();
  box.capabilities.readPull = (): ReturnType<FixCapabilities["readPull"]> =>
    null;
  box.capabilities.openWriter = (): ReturnType<FixCapabilities["openWriter"]> =>
    unexpected("no PR to fix");
  assert.equal(
    (await fix.run(INPUTS, box.capabilities, CONTEXT)).status,
    "blocked",
  );
});
test("a fourth review round asks for input and publishes no changes", async () => {
  const box = machine();
  box.current.reviews = Array.from(
    { length: ROUND_LIMIT + 1 },
    (_, index: number): number => index + 1,
  ).map((id) => ({
    id,
    author: "reviewer",
    state: "CHANGES_REQUESTED",
    commit: HEAD,
    body: "Fix",
  }));
  box.capabilities.openWriter = (): ReturnType<FixCapabilities["openWriter"]> =>
    unexpected("round limit");
  assert.equal(
    (await fix.run(INPUTS, box.capabilities, CONTEXT)).status,
    "needs-input",
  );
  assert.equal(box.pushes(), 0);
});
test("a model that cannot resolve a conflict retains work and asks for input", async () => {
  const box = machine();
  box.capabilities.openWriter = (): ReturnType<
    FixCapabilities["openWriter"]
  > => ({
    directory: "/supplied/repo",
    conflicts: ["count.ts"],
    push: (): string => unexpected("unresolved work"),
    remove: (): void => unexpected("retain work"),
    session: () =>
      Promise.resolve({ outcome: "cannot", reason: "Author must choose" }),
  });
  assert.equal(
    (await fix.run(INPUTS, box.capabilities, CONTEXT)).status,
    "needs-input",
  );
});

function unexpected(message: string): never {
  throw new Error(message);
}
