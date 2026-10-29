import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { entity } from "../../monitor/records.ts";
import {
  RetryRequests,
  type RetryTarget,
  retryTarget,
} from "../../monitor/retry.ts";

const START_LABEL = /start:implement/u;
const ALREADY_REQUESTED = /already requested/u;
const ALREADY_PRESENT = /already present/u;
const CLOSED = /closed/u;
const UNCONFIRMED = /could not be confirmed/u;
const NOT_CONFIGURED = /not configured/u;
const time = "2026-10-28T12:00:00.000Z";
const repo = "axolotl-logic-io/project-buddy";
const issue = 541;
const endpoint = `repos/${repo}/issues/${issue}`;
const target: RetryTarget = {
  action: "action",
  repo,
  issue,
  task: "implement",
};

function action(state: string, kind = "action"): MonitorEntity {
  return entity({
    id: "action",
    kind,
    repo,
    issue,
    title: "Implement",
    state,
    task: "implement",
    sourceAt: time,
    startedAt: time,
    endedAt: time,
  });
}

interface FakeGitHub {
  calls: string[][];
  requests: RetryRequests;
}

// A gh stand-in: it answers the issue read with `state` and `labels`, and
// either applies label POSTs or fails them after they may have applied.
function github(
  issueState: "open" | "closed",
  labels: string[],
  post: "applies" | "lost" = "applies",
): FakeGitHub {
  const calls: string[][] = [];
  function command(
    _command: string,
    args: string[],
  ): Promise<{ stdout: string }> {
    calls.push(args);
    if (args.includes("POST")) {
      if (post === "lost") {
        return Promise.reject(new Error("connection reset"));
      }
      return Promise.resolve({ stdout: "" });
    }
    return Promise.resolve({
      stdout: JSON.stringify({
        state: issueState,
        labels: labels.map((name) => ({ name })),
      }),
    });
  }
  return { calls, requests: new RetryRequests([repo], command) };
}

function posts(fake: FakeGitHub): string[][] {
  return fake.calls.filter((args): boolean => args.includes("POST"));
}

test("only a settled, unsuccessful task action can be retried", (): void => {
  for (const state of ["failed", "blocked", "interrupted", "unknown"]) {
    assert.deepEqual(retryTarget(action(state)), target);
  }
  for (const state of ["running", "passed", "refused"]) {
    assert.equal(retryTarget(action(state)), null);
  }
  assert.equal(retryTarget(action("failed", "session")), null);
  assert.equal(retryTarget(undefined), null);
});

test("a retry applies the task's start label once per selected attempt", async (): Promise<void> => {
  const fake = github("open", []);
  const first = await fake.requests.request(target);
  assert.match(first, START_LABEL);
  assert.deepEqual(posts(fake), [
    [
      "api",
      "--method",
      "POST",
      `${endpoint}/labels`,
      "-f",
      "labels[]=start:implement",
      "--silent",
    ],
  ]);
  const again = await fake.requests.request(target);
  assert.match(again, ALREADY_REQUESTED);
  assert.equal(posts(fake).length, 1);
});

test("a present start label or a closed issue requests nothing", async (): Promise<void> => {
  const labelled = github("open", ["start:implement"]);
  assert.match(await labelled.requests.request(target), ALREADY_PRESENT);
  assert.deepEqual(posts(labelled), []);
  const closed = github("closed", []);
  assert.match(await closed.requests.request(target), CLOSED);
  assert.deepEqual(posts(closed), []);
});

test("a retry whose label write is unconfirmed is never written again", async (): Promise<void> => {
  const fake = github("open", [], "lost");
  assert.match(await fake.requests.request(target), UNCONFIRMED);
  assert.match(await fake.requests.request(target), ALREADY_REQUESTED);
  assert.equal(posts(fake).length, 1);
});

test("a retry for an unconfigured repository is refused before any read", async (): Promise<void> => {
  const fake = github("open", []);
  await assert.rejects(
    fake.requests.request({ ...target, repo: "someone/else" }),
    NOT_CONFIGURED,
  );
  assert.deepEqual(fake.calls, []);
});
