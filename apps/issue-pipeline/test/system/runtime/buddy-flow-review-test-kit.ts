// The review loop's evidence on a buddy flow machine (buddy-flow-test-kit.ts),
// for the Fix flow tests: a real Implement that opens the item's PR, a real
// move of the target, and what the landing account's Verify or Land would
// have left behind when no such buddy runs here: their authenticated task
// records on the issue and Verify's submitted review on the PR, written as
// GitHub would store them. A person's review is the review GitHub stores
// for the human.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Binding, TaskResult } from "../../../src/domain.ts";
import type { Result, TaskRecord } from "../../../src/tasks/records.ts";
import { RECORD, recordBody } from "../../../src/tasks/records.ts";
import type { FakeReview } from "../../support/signals/fake-github-world.ts";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { HARDENING, ISSUE, marked } from "./buddy-flow-test-kit.ts";

const BRANCH = `agent/issue-${ISSUE}`;
const IMPLEMENT_POLLS = 2;
const SHA256_HEX = 64;
// Stands for the checking policy digest a real Verify or Land run binds;
// Fix reads only the head a result is bound to.
const POLICY = "c".repeat(SHA256_HEX);
const REQUIREMENTS_PREFIX = "sha256:";
const POSTED_AT = "2026-10-25T14:00:00Z";
const WRITES: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "three widgets\n",
    message: "Count the widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};

// The item's implemented code: its PR's head, the PR and the record id of
// Implement's passed result.
interface Implemented {
  head: string;
  pr: number;
  result: number;
}

// A line comment a review opens a thread with.
interface LineComment {
  path: string;
  line: number;
  body: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// The issue's task records, parsed, oldest first, with their comment ids.
function records(box: Machine): (TaskRecord & { id: number })[] {
  const issue = box.world().issues.find((item) => item.number === ISSUE);
  return marked(box.world(), "task-result").map((record, at) => {
    const comment = (issue?.comments ?? []).filter((item) =>
      item.body.includes("<!-- agent-pipeline:task-result\n"),
    )[at];
    return { ...RECORD.parse(record), id: comment?.id ?? 0 };
  });
}

function results(box: Machine): (Result & { id: number })[] {
  return records(box).filter(
    (record): record is Result & { id: number } => record.kind === "result",
  );
}

// Runs a real Implement, with a hardening that changes nothing, and reads
// back its PR and result.
async function implemented(
  box: Machine,
  signal: AbortSignal,
): Promise<Implemented> {
  const run = await box.runBuddy(
    [WRITES, HARDENING],
    IMPLEMENT_POLLS,
    undefined,
    signal,
  );
  if (run.actions[0]?.verdict !== "passed") {
    throw new Error(`Implement did not pass: ${run.stderr}`);
  }
  const pr = box.world().pulls?.[0]?.number;
  const result = results(box).find((item) => item.binding.task === "implement");
  if (pr === undefined || result === undefined) {
    throw new Error("Implement opened no PR or recorded no result");
  }
  return { head: box.git(["rev-parse", BRANCH]), pr, result: result.id };
}

// Moves the target with a commit that writes `content` to `file`, and
// returns the new tip.
function advanceTarget(box: Machine, file: string, content: string): string {
  git(box.work, ["checkout", "--quiet", "main"]);
  git(box.work, ["pull", "--quiet", "origin", "main"]);
  fs.writeFileSync(path.join(box.work, file), content);
  git(box.work, ["add", file]);
  git(box.work, ["commit", "--quiet", "-m", "Advance the target"]);
  git(box.work, ["push", "--quiet", "origin", "main"]);
  return box.git(["rev-parse", "main"]);
}

// The revision binding of `task` for `head` on target `target`, under the
// item's current trusted inputs.
function revisionBinding(
  box: Machine,
  task: "verify" | "fix" | "land",
  head: string,
  target: string,
): Binding {
  const implement = results(box).find(
    (item) => item.binding.task === "implement",
  );
  if (implement === undefined || !("requirements" in implement.binding)) {
    throw new Error("no Implement result to read the trusted inputs from");
  }
  return {
    workItem: implement.binding.workItem,
    task,
    target: { branch: "main", commit: target },
    revision: {
      code: head,
      inputs: implement.binding.requirements.slice(REQUIREMENTS_PREFIX.length),
      policy: POLICY,
    },
  };
}

// Appends one settled run of `binding`, caused by result `cause`, as the
// landing account's attempt and result records; returns the result's id.
function recordRun(
  box: Machine,
  run: {
    binding: Binding;
    cause: number;
    verdict: TaskResult["verdict"];
    receipt: TaskResult["receipt"];
  },
): number {
  const shared = {
    version: 2,
    binding: run.binding,
    run: { id: randomUUID(), previous: null },
    buddyRun: randomUUID(),
    cause: { signal: `result:${String(run.cause)}`, recordId: run.cause },
  } as const;
  let id = 0;
  box.change((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    const bodies = [
      recordBody({ ...shared, kind: "attempt" }),
      recordBody({
        ...shared,
        kind: "result",
        verdict: run.verdict,
        receipt: run.receipt,
      }),
    ];
    for (const body of bodies) {
      id = world.nextId;
      world.nextId += 1;
      issue.comments.push({
        id,
        author: LANDING,
        body,
        editor: null,
        createdAt: POSTED_AT,
      });
    }
  });
  return id;
}

// A review by `author` of PR `pr`'s `head`, opening a thread for each of
// `comments`; returns the review's id and each thread's id.
function review(
  box: Machine,
  submitted: {
    pr: number;
    head: string;
    author: string;
    state: FakeReview["state"];
    body: string;
    comments: readonly LineComment[];
  },
): { id: number; threads: number[] } {
  let id = 0;
  const threads: number[] = [];
  box.change((world) => {
    const pull = world.pulls?.find((item) => item.number === submitted.pr);
    if (pull === undefined) {
      throw new Error(`the world has no PR ${String(submitted.pr)}`);
    }
    id = world.nextId;
    world.nextId += 1;
    pull.reviews ??= [];
    pull.reviews.push({
      id,
      author: submitted.author,
      state: submitted.state,
      commitId: submitted.head,
      body: submitted.body,
      submittedAt: POSTED_AT,
    });
    pull.reviewComments ??= [];
    for (const comment of submitted.comments) {
      threads.push(world.nextId);
      pull.reviewComments.push({
        id: world.nextId,
        review: id,
        inReplyTo: null,
        author: submitted.author,
        path: comment.path,
        line: comment.line,
        commitId: submitted.head,
        body: comment.body,
        createdAt: POSTED_AT,
      });
      world.nextId += 1;
    }
  });
  return { id, threads };
}

// What Verify leaves when it requests changes on `item`'s head on target
// `target`: the landing account's review with `comments`, and its refused
// result, caused by Implement's; returns the result's id and the threads.
function verifyRequestsChanges(
  box: Machine,
  item: Implemented,
  found: { target: string; body: string; comments: readonly LineComment[] },
): { result: number; threads: number[] } {
  const submitted = review(box, {
    pr: item.pr,
    head: item.head,
    author: LANDING,
    state: "CHANGES_REQUESTED",
    body: found.body,
    comments: found.comments,
  });
  const result = recordRun(box, {
    binding: revisionBinding(box, "verify", item.head, found.target),
    cause: item.result,
    verdict: "refused",
    receipt: {
      summary: "Verify requested changes",
      evidence: {
        review: {
          id: submitted.id,
          pr: item.pr,
          commit: item.head,
          state: "CHANGES_REQUESTED",
        },
        blocking: found.comments.length,
        nits: 0,
        security: false,
      },
    },
  });
  return { result, threads: submitted.threads };
}

// What Land leaves when it finds `item`'s approved PR conflicting with
// target `target`: the PR marked a draft, and its refused result, caused by
// result `cause`; returns the result's id.
function landFindsConflict(
  box: Machine,
  item: Implemented,
  found: { target: string; cause: number },
): number {
  box.change((world) => {
    const pull = world.pulls?.find((entry) => entry.number === item.pr);
    if (pull !== undefined) {
      pull.isDraft = true;
    }
  });
  return recordRun(box, {
    binding: revisionBinding(box, "land", item.head, found.target),
    cause: found.cause,
    verdict: "refused",
    receipt: {
      summary: "the approved PR conflicts with its base; marked it a draft",
      evidence: {
        outcome: "conflict",
        pr: item.pr,
        head: item.head,
        base: { branch: "main", commit: found.target },
        reason: "GitHub reports the PR as conflicting with main",
      },
    },
  });
}

export type { Implemented, LineComment };
export {
  advanceTarget,
  BRANCH,
  implemented,
  landFindsConflict,
  recordRun,
  records,
  results,
  review,
  revisionBinding,
  verifyRequestsChanges,
};
