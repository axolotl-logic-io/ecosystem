import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@ecosystem/task-framework";
import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { type LandCapabilities, land } from "../../src/index.ts";

const SHA_LENGTH = 40;
const HEAD_MOVED = /head moved/u;
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

const INPUTS = { issue: { repo: "example/widgets", number: 7 } };
function machine(): {
  capabilities: LandCapabilities;
  current: PullRequest;
  writes: string[][];
  issue: { state: string };
} {
  const current = pull();
  current.isDraft = false;
  current.reviews.push({
    id: 1,
    author: "reviewer",
    state: "APPROVED",
    commit: HEAD,
    body: "Reviewed",
  });
  current.checks.push({ name: "check", state: "SUCCESS", bucket: "pass" });
  const writes: string[][] = [];
  const issue = { state: "open" };
  return {
    current,
    writes,
    issue,
    capabilities: {
      recovery: {
        pullRequest: (): PullRequest => current,
        issue: () => ({
          number: 7,
          title: "Count",
          body: "Count widgets",
          author: "owner",
          labels: [],
          state: issue.state,
        }),
      },
      report: (): void => undefined,
      github: {
        checkStop: (): void => undefined,
        readJson: (args: readonly string[]): unknown => {
          if (args[0] === "pr") {
            return {
              state: current.state,
              isDraft: current.isDraft,
              headRefOid: current.headSha,
              baseRefName: "main",
              mergeable: "MERGEABLE",
              mergeCommit: { oid: HEAD },
            };
          }
          if (args[1]?.includes("/permission")) {
            return { permission: "write" };
          }
          return { behind_by: 0 };
        },
        writeResult: (
          args: readonly string[],
        ): ReturnType<LandCapabilities["github"]["writeResult"]> => {
          writes.push([...args]);
          if (args[0] === "pr" && args[1] === "merge") {
            current.state = "MERGED";
          }
          if (args[0] === "issue") {
            issue.state = "closed";
          }
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        },
        failure: (): OpsError => new OpsError("write refused"),
      },
    },
  };
}
test("a host can merge only the approved pinned head and close the issue", async () => {
  const box = machine();
  assert.equal(
    (await land.run(INPUTS, box.capabilities, CONTEXT)).status,
    "completed",
  );
  assert.ok(
    box.writes.some(
      (args) => args.includes("--match-head-commit") && args.at(-1) === HEAD,
    ),
  );
  assert.equal(box.issue.state, "closed");
});
test("missing approval is blocked without remote effects", async () => {
  const box = machine();
  box.current.reviews = [];
  assert.equal(
    (await land.run(INPUTS, box.capabilities, CONTEXT)).status,
    "blocked",
  );
  assert.equal(box.writes.length, 0);
});
test("an already merged PR reconciles closure without merging twice", async () => {
  const box = machine();
  box.current.state = "MERGED";
  assert.equal(
    (await land.run(INPUTS, box.capabilities, CONTEXT)).status,
    "no-change",
  );
  assert.equal(box.writes.filter((args) => args[0] === "pr").length, 0);
  assert.equal(box.issue.state, "closed");
});
test("a head that moves during authoritative reads is never merged", async () => {
  const box = machine();
  const read = box.capabilities.github.readJson;
  box.capabilities.github.readJson = (args: readonly string[]): unknown => {
    if (args[0] === "pr") {
      return {
        state: "OPEN",
        isDraft: false,
        headRefOid: MOVED,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeCommit: null,
      };
    }
    return read(args);
  };
  await assert.rejects(async (): Promise<void> => {
    await land.run(INPUTS, box.capabilities, CONTEXT);
  }, HEAD_MOVED);
  assert.equal(box.writes.length, 0);
});
