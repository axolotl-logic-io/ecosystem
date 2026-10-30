import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FakeReview } from "../../support/signals/fake-github-world.ts";
import type { Machine } from "./buddy-flow-test-kit.ts";

const POSTED_AT = "2026-10-25T14:00:00Z";
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

function advanceTarget(box: Machine, file: string, content: string): string {
  git(box.work, ["checkout", "--quiet", "main"]);
  git(box.work, ["pull", "--quiet", "origin", "main"]);
  fs.writeFileSync(path.join(box.work, file), content);
  git(box.work, ["add", file]);
  git(box.work, ["commit", "--quiet", "-m", "Advance the target"]);
  git(box.work, ["push", "--quiet", "origin", "main"]);
  return box.git(["rev-parse", "main"]);
}

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

export { advanceTarget, review };
