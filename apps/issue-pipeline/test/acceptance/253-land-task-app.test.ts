// Issue #253's scenarios, one test each, run against the Land task app on
// the task app framework, fake GitHub and a real local origin.
//
// Feature: Land merges the issue's PR and closes the issue
//
//   Scenario: Land merges an approved head with green CI
//     Given the PR's head has Verify's approval and green required CI
//     When a buddy runs Land
//     Then the PR is merged with a merge commit of exactly that head
//     And the issue is closed once
//
//   Scenario: A missing prerequisite ends Land with a comment naming it
//     Given the PR's head has an approval only from an account that can't
//       write, a person's request for changes, pending CI and no base
//     When a buddy runs Land
//     Then nothing is merged
//     And Land's comment names each missing prerequisite
//
//   Scenario: Land marks a conflicting PR as a draft for Fix
//     Given an approved PR whose head conflicts with its base
//     When a buddy runs Land
//     Then the PR is a draft and unmerged
//     And Land's comment names `start:fix`
//
//   Scenario: A rerun after a lost merge response closes the issue
//     Given Land's merge applied, but its response and the issue's close
//       were lost
//     When a person applies `start:land` again and a buddy runs Land
//     Then the issue is closed
//     And the PR was merged only once
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import type {
  FakeComment,
  FakeReview,
  World,
} from "../support/signals/fake-github-world.ts";
import {
  apply,
  BUDDIES,
  issueOf,
  type Machine,
  machine,
  PERSON,
} from "../support/task-app/task-app-test-kit.ts";

const LAND = path.join(import.meta.dirname, "../../src/task-apps/land.ts");
const START = "start:land";
const BRANCH = "agent/issue-7";
const PULL = 8;
const SUBMITTED = "2026-10-25T13:00:00Z";
const VISITOR = "visitor";
const FIRST_REVIEW = 300;
const FAILED = /Task `land` failed at its work step/u;
const NO_APPROVAL =
  /an approval on `[0-9a-f]{40}` from Verify's account or a person with write access/u;
const CHANGES = /@autumn requested changes/u;
const CI_PENDING = /green required CI on `[0-9a-f]{40}`: test is pending/u;
const NO_BASE = /a head that contains `main`: apply `start:fix`/u;
const RETRY = /To retry, apply `start:land` again\./u;
const START_FIX = /To resolve the conflict, apply `start:fix`\./u;
const ALREADY = /already merged into `main`/u;

// How the origin's `main` and the issue's branch relate: the branch adds a
// file to main's start; main may then move on with a change to another
// file, or to the file the branch changes too.
type Shape = "clean" | "behind" | "conflict";
interface Origin {
  origin: string;
  head: string;
  main: string;
}
interface Pr {
  body?: string;
  reviews?: { author: string; state: FakeReview["state"] }[];
  checks?: "pass" | "pending";
}

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

function commit(work: string, file: string, text: string): void {
  fs.writeFileSync(path.join(work, file), text);
  git(work, ["add", file]);
  git(work, ["commit", "-m", `Change ${file}`]);
}

function origin(root: string, shape: Shape): Origin {
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  fs.mkdirSync(bare);
  git(bare, ["init", "--bare", "--initial-branch=main"]);
  fs.mkdirSync(work);
  git(work, ["init", "--initial-branch=main"]);
  commit(work, "widget.txt", "one\n");
  git(work, ["switch", "-c", BRANCH]);
  commit(work, "feature.txt", "feature\n");
  if (shape === "conflict") {
    commit(work, "widget.txt", "the branch's\n");
  }
  git(work, ["switch", "main"]);
  if (shape === "conflict") {
    commit(work, "widget.txt", "main's\n");
  } else if (shape === "behind") {
    commit(work, "other.txt", "other\n");
  }
  git(work, ["push", bare, "main", BRANCH]);
  return {
    origin: bare,
    head: git(work, ["rev-parse", BRANCH]),
    main: git(work, ["rev-parse", "main"]),
  };
}

// Issue ISSUE with `start:land` applied by a person, and its PR from
// BRANCH, opened by the development buddy, at `head`.
function landWorld(world: World, head: string, pr: Pr): void {
  const issue = issueOf(world);
  issue.labels = [START];
  for (const event of issue.events) {
    event.label = START;
  }
  world.accounts.push({ login: VISITOR, id: 11, type: "User" });
  world.collaborators = [BUDDIES.hippy, BUDDIES.lawd, PERSON];
  world.pulls = [
    {
      number: PULL,
      head: BRANCH,
      base: "main",
      title: "Add the feature",
      body: pr.body ?? "Closes #7",
      author: BUDDIES.hippy,
      state: "OPEN",
      isDraft: false,
      reviews: (pr.reviews ?? []).map((review, at) => ({
        id: FIRST_REVIEW + at,
        author: review.author,
        state: review.state,
        commitId: head,
        body: "",
        submittedAt: SUBMITTED,
      })),
    },
  ];
  world.checks = { [head]: [{ name: "test", bucket: pr.checks ?? "pass" }] };
}

// A machine running Land over an origin of `shape` whose PR is `pr`.
function landMachine(
  scratch: string,
  shape: Shape,
  pr: Pr,
  edit: (world: World) => void = (): void => undefined,
): { box: Machine; repo: Origin } {
  const repo = origin(scratch, shape);
  const box = machine(
    (world) => {
      landWorld(world, repo.head, pr);
      edit(world);
    },
    { origin: repo.origin, app: LAND, task: "land" },
  );
  return { box, repo };
}

function landComments(box: Machine, kind: string): FakeComment[] {
  return issueOf(box.world()).comments.filter((comment) =>
    comment.body.includes(`<!-- task-app:land:${kind} `),
  );
}

function pull(box: Machine): NonNullable<World["pulls"]>[number] {
  const [found] = box.world().pulls ?? [];
  if (found === undefined) {
    throw new Error("the world has no PR");
  }
  return found;
}

// The merge commits on the origin's `main`.
function merges(repo: Origin): string[] {
  return git(repo.origin, ["rev-list", "--merges", "main"])
    .split("\n")
    .filter((line) => line !== "");
}

function closes(box: Machine): number {
  return issueOf(box.world()).events.filter((event) => event.event === "closed")
    .length;
}

const APPROVED: Pr = {
  reviews: [{ author: BUDDIES.lawd, state: "APPROVED" }],
};

async function withScratch(
  body: (scratch: string) => Promise<void>,
): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "land-origin-"));
  try {
    await body(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test("Scenario: Land merges an approved head with green CI", async () => {
  await withScratch(async (scratch) => {
    const { box, repo } = landMachine(scratch, "clean", APPROVED);
    try {
      assert.equal((await box.runToEnd("lawd")).status, 0);
      const [merge, ...others] = merges(repo);
      assert.deepEqual(others, []);
      assert.equal(git(repo.origin, ["rev-parse", "main"]), merge);
      assert.deepEqual(
        git(repo.origin, ["rev-list", "--parents", "-n", "1", "main"]).split(
          " ",
        ),
        [merge, repo.main, repo.head],
      );
      assert.equal(pull(box).state, "MERGED");
      assert.equal(closes(box), 1);
      assert.notEqual(issueOf(box.world()).closed, undefined);
      assert.equal(landComments(box, "merged").length, 1);
      assert.deepEqual(issueOf(box.world()).labels, []);
    } finally {
      box.cleanup();
    }
  });
});

test("Scenario: A missing prerequisite ends Land with a comment naming it", async () => {
  await withScratch(async (scratch) => {
    const { box, repo } = landMachine(scratch, "behind", {
      reviews: [
        { author: VISITOR, state: "APPROVED" },
        { author: PERSON, state: "CHANGES_REQUESTED" },
      ],
      checks: "pending",
    });
    try {
      assert.equal((await box.runToEnd("lawd")).status, 1);
      assert.deepEqual(merges(repo), []);
      assert.equal(git(repo.origin, ["rev-parse", "main"]), repo.main);
      assert.equal(pull(box).state, "OPEN");
      assert.equal(issueOf(box.world()).closed, undefined);
      const [end] = landComments(box, "end");
      const body = end?.body ?? "";
      for (const named of [
        FAILED,
        NO_APPROVAL,
        CHANGES,
        CI_PENDING,
        NO_BASE,
        RETRY,
      ]) {
        assert.match(body, named);
      }
      assert.deepEqual(issueOf(box.world()).labels, []);
    } finally {
      box.cleanup();
    }
  });
});

test("Scenario: Land marks a conflicting PR as a draft for Fix", async () => {
  await withScratch(async (scratch) => {
    const { box, repo } = landMachine(scratch, "conflict", APPROVED);
    try {
      assert.equal((await box.runToEnd("lawd")).status, 0);
      assert.deepEqual(merges(repo), []);
      assert.equal(pull(box).state, "OPEN");
      assert.equal(pull(box).isDraft, true);
      const [conflict, ...others] = landComments(box, "conflict");
      assert.deepEqual(others, []);
      assert.match(conflict?.body ?? "", START_FIX);
      assert.equal(issueOf(box.world()).closed, undefined);
    } finally {
      box.cleanup();
    }
  });
});

test("Scenario: A rerun after a lost merge response closes the issue", async () => {
  await withScratch(async (scratch) => {
    const { box, repo } = landMachine(
      scratch,
      "clean",
      { ...APPROVED, body: "Adds the feature." },
      (world) => {
        world.loseMergeResponses = 1;
        world.failIssueCloses = 1;
      },
    );
    try {
      assert.equal((await box.runToEnd("lawd")).status, 1);
      assert.equal(pull(box).state, "MERGED");
      assert.equal(issueOf(box.world()).closed, undefined);
      box.change((world) => apply(world, START));
      assert.equal((await box.runToEnd("lawd")).status, 0);
      assert.equal(merges(repo).length, 1);
      assert.equal(closes(box), 1);
      assert.equal(issueOf(box.world()).closed?.by, BUDDIES.lawd);
      const [first, second, ...others] = landComments(box, "merged");
      assert.deepEqual(others, []);
      assert.notEqual(first, undefined);
      assert.match(second?.body ?? "", ALREADY);
      assert.deepEqual(issueOf(box.world()).labels, []);
    } finally {
      box.cleanup();
    }
  });
});
