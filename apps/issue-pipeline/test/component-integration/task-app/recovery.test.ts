// The shared readers a task run continues from: the issue's branch and its
// commits, and the PR from that branch with its reviews, review threads and
// required checks, read from fake GitHub over a real local origin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  BUDDIES,
  machine,
  REPO,
} from "../../support/task-app/task-app-test-kit.ts";

const SUBMITTED = "2026-10-25T13:00:00Z";
const PULL = 8;

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["GIT_AUTHOR_NAME", "Test"],
        ["GIT_AUTHOR_EMAIL", "test@example.test"],
        ["GIT_COMMITTER_NAME", "Test"],
        ["GIT_COMMITTER_EMAIL", "test@example.test"],
      ]),
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

// A bare origin whose `main` has one commit and whose `agent/issue-7` adds
// two; returns the origin and the branch's head.
function origin(root: string): { origin: string; head: string } {
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  fs.mkdirSync(bare);
  git(bare, ["init", "--bare", "--initial-branch=main"]);
  fs.mkdirSync(work);
  git(work, ["init", "--initial-branch=main"]);
  git(work, ["commit", "--allow-empty", "-m", "Start"]);
  git(work, ["switch", "-c", "agent/issue-7"]);
  git(work, ["commit", "--allow-empty", "-m", "Add the widget"]);
  git(work, ["commit", "--allow-empty", "-m", "Test the widget"]);
  git(work, ["push", bare, "main", "agent/issue-7"]);
  return { origin: bare, head: git(work, ["rev-parse", "HEAD"]) };
}

test("the readers show the issue's branch and its PR as earlier runs left them", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "task-app-origin-"));
  const { origin: bare, head } = origin(scratch);
  const box = machine(
    (world) => {
      world.pulls = [
        {
          number: PULL,
          head: "agent/issue-7",
          base: "main",
          title: "Add the widget",
          body: "Closes #7",
          author: BUDDIES.hippy,
          state: "OPEN",
          isDraft: false,
          reviews: [
            {
              id: 21,
              author: "autumn",
              state: "CHANGES_REQUESTED",
              commitId: head,
              body: "Please rename it.",
              submittedAt: SUBMITTED,
            },
          ],
          reviewComments: [
            {
              id: 31,
              review: 21,
              inReplyTo: null,
              author: "autumn",
              path: "widget.ts",
              line: 3,
              commitId: head,
              body: "Rename this.",
              createdAt: SUBMITTED,
            },
            {
              id: 32,
              review: null,
              inReplyTo: 31,
              author: BUDDIES.hippy,
              path: "widget.ts",
              line: 3,
              commitId: head,
              body: "Renamed.",
              createdAt: SUBMITTED,
            },
          ],
        },
      ];
      world.checks = { [head]: [{ name: "test", bucket: "pass" }] };
    },
    { origin: bare },
  );
  const saved = { ...process.env };
  try {
    const { PATH: searchPath = "" } = saved;
    Object.assign(
      process.env,
      Object.fromEntries([
        ["PATH", `${box.bin}:${searchPath}`],
        ["ISSUE_PIPELINE_ROOT", box.pipeline],
      ]),
    );
    const { IssueGitHub } = await import(
      "../../../src/task-app/issue-github.ts"
    );
    const { recovery } = await import("../../../src/task-app/recovery.ts");
    const github = new IssueGitHub(
      { repo: REPO, number: 7 },
      { account: BUDDIES.hippy, env: new Map([["GH_TOKEN", "dev-token"]]) },
    );
    const readers = recovery(github, "sample", "main");
    assert.equal(readers.issue().title, "Sample work");
    const branch = readers.branch();
    assert.equal(branch?.head, head);
    assert.deepEqual(
      branch?.commits.map((commit) => commit.message),
      ["Add the widget", "Test the widget"],
    );
    const pull = readers.pullRequest();
    assert.equal(pull?.number, PULL);
    assert.equal(pull?.headSha, head);
    assert.deepEqual(
      pull?.reviews.map((review) => [
        review.author,
        review.state,
        review.commit,
      ]),
      [["autumn", "CHANGES_REQUESTED", head]],
    );
    assert.deepEqual(
      pull?.threads.map((thread) => thread.comments.map((item) => item.body)),
      [["Rename this.", "Renamed."]],
    );
    assert.deepEqual(
      pull?.checks.map((check) => [check.name, check.bucket]),
      [["test", "pass"]],
    );
  } finally {
    process.env = saved;
    box.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
