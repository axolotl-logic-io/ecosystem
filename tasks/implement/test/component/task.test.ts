import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "@ecosystem/task-framework";
import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import {
  type ImplementCapabilities,
  implement,
  implementInputs,
  type WriterSession,
} from "../../src/index.ts";

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

const INPUTS = {
  issue: { repo: "example/widgets", number: 7 },
  account: "writer",
  developmentAccount: "writer",
  baseBranch: "main",
  testCommand: "npm test",
  model: "provider/model",
};
function machine(reply: unknown = { outcome: "done", summary: "Finished" }): {
  capabilities: ImplementCapabilities;
  sessions: WriterSession[];
  effects: string[][];
  current: PullRequest;
  closed: () => boolean;
} {
  const current = pull();
  const sessions: WriterSession[] = [];
  const effects: string[][] = [];
  let closed = false;
  return {
    current,
    sessions,
    effects,
    closed: (): boolean => closed,
    capabilities: {
      github: {
        stopped: (): boolean => false,
        change: (args: readonly string[]): string => {
          effects.push([...args]);
          return "";
        },
      },
      recovery: {
        pullRequest: (): PullRequest => current,
        branch: () => null,
        issue: () => ({
          number: 7,
          title: "Count",
          body: "Count widgets",
          state: "open",
          author: "owner",
          labels: [],
        }),
      },
      openCheckout: () => ({
        ahead: (): number => 1,
        start: (): void => unexpected("existing work needs no seed"),
        push: () => ({ kind: "current", head: HEAD }),
        close: (): Promise<void> => {
          closed = true;
          return Promise.resolve();
        },
      }),
      writeBrief: (): string => "/supplied/context.md",
      openSessions: () =>
        Promise.resolve({
          run: (session: WriterSession) => {
            sessions.push(session);
            return Promise.resolve({ ok: true, reply });
          },
          abort: (): void => undefined,
          close: (): void => undefined,
        }),
      checkStop: (): void => undefined,
      report: (): void => undefined,
      retained: (): void => unexpected("unexpected close failure"),
    },
  };
}
test("supplied capabilities develop and harden an existing draft before ready", async () => {
  const box = machine();
  const result = await implement.run(
    implementInputs.parse(INPUTS),
    box.capabilities,
    CONTEXT,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(
    box.sessions.map((session) => session.page),
    ["developer.md", "developer-hardening.md"],
  );
  assert.ok(box.effects.some((args) => args[1] === "ready"));
  assert.equal(box.closed(), true);
});
test("a model that needs help leaves the draft and closes recoverable work", async () => {
  const box = machine({ outcome: "cannot", reason: "Author must clarify" });
  const result = await implement.run(INPUTS, box.capabilities, CONTEXT);
  assert.equal(result.status, "needs-input");
  assert.equal(box.effects.length, 0);
  assert.equal(box.closed(), true);
});
test("a moved remote head prevents marking the draft ready", async () => {
  const box = machine();
  box.capabilities.openSessions = (): ReturnType<
    ImplementCapabilities["openSessions"]
  > =>
    Promise.resolve({
      run: () => {
        box.current.headSha = MOVED;
        return Promise.resolve({
          ok: true,
          reply: { outcome: "done", summary: "Finished" },
        });
      },
      abort: (): void => undefined,
      close: (): void => undefined,
    });
  await assert.rejects(
    implement.run(INPUTS, box.capabilities, CONTEXT),
    HEAD_MOVED,
  );
  assert.equal(box.effects.length, 0);
  assert.equal(box.closed(), true);
});
test("a merged PR returns no-change without opening a checkout", async () => {
  const box = machine();
  box.current.state = "MERGED";
  box.capabilities.openCheckout = (): ReturnType<
    ImplementCapabilities["openCheckout"]
  > => unexpected("merged work is untouched");
  assert.equal(
    (await implement.run(INPUTS, box.capabilities, CONTEXT)).status,
    "no-change",
  );
});

function unexpected(message: string): never {
  throw new Error(message);
}
