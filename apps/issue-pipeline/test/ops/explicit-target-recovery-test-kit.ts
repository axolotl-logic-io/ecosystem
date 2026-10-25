// Recovery uses a private fake GitHub, saved authoritative comments and real
// merge objects. Child interruption is at an explicit protocol boundary.

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { MergeReply } from "../../src/ops/merge.ts";
import type { IssueState } from "../../src/state.ts";
import type { GhStep } from "../explicit-target-test-kit.ts";
import {
  calls,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  resultInputs,
  script,
} from "../explicit-target-test-kit.ts";
import type { World } from "../explicit-target-world-test-kit.ts";
import {
  BRANCH,
  git,
  ISSUE,
  PR,
  REPO,
} from "../explicit-target-world-test-kit.ts";
import { confirmationClock } from "./confirmation-clock-test-kit.ts";

const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { stateBody, readWriteState }: typeof import("../../src/saved-state.ts") =
  await import("../../src/saved-state.ts");
const { signed }: typeof import("../../src/comments.ts") = await import(
  "../../src/comments.ts"
);
const { mergedText }: typeof import("../../src/ops/merge-comment.ts") =
  await import("../../src/ops/merge-comment.ts");
function confirmation(w: World): GhStep[] {
  const steps = [prStep(w, mergedView(w))];
  if (w.merged !== w.head) {
    steps.push(prStep(w, mergedView(w), true));
  }
  return [...steps, ...resultInputs(w)];
}
function posts(): string[][] {
  return calls().filter((args) => args[0] === "git" && args.includes("push"));
}
function expectedTargetPush(w: World): {
  origin: string;
  ref: string;
  old: string;
  head: string;
} {
  return {
    origin: w.origin,
    ref: `refs/heads/${w.cfg.baseBranch}`,
    old: w.base,
    head: w.head,
  };
}
function staleConfirmation(
  w: World,
  waits: readonly number[],
): {
  clock: ReturnType<typeof confirmationClock>;
  reply: MergeReply;
} {
  const clock = confirmationClock();
  script(w, [
    ...prechecks(w),
    post(w),
    ...waits.map(() => prStep(w, { state: "CLOSED", mergeCommit: null })),
  ]);
  const reply = merge(w.cfg, request(w), clock);
  return { clock, reply };
}
function child(w: World, payload: object): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      new URL("./explicit-target-recovery-child-test-kit.ts", import.meta.url)
        .pathname,
    ],
    {
      input: JSON.stringify({
        op: "reconcile-merge",
        ...payload,
        payload,
        slug: w.cfg.slug,
        config: path.join(w.place, "config.json"),
        checkout: { issue: ISSUE, dir: w.wt, branch: BRANCH },
      }),
      cwd: w.wt,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
function retainLegacyAttempt(w: World, result: string | null = w.merged): void {
  const state = {
    ...w.state,
    mergeAttempt: {
      repo: w.cfg.repo,
      pr: PR,
      target: w.cfg.baseBranch,
      branch: BRANCH,
      authorized: w.revision,
      hardened: w.state.hardened ?? w.revision,
      integration: w.state.integration,
      result,
      reads: 0,
    },
  };
  fs.writeFileSync(path.join(w.place, "state.json"), stateBody(ISSUE, state));
  git(w.origin, ["update-ref", `refs/heads/${w.cfg.baseBranch}`, w.merged]);
}

function interruptAfterResponse(w: World): {
  interrupted: SpawnSyncReturns<string>;
  saved: IssueState;
} {
  let interrupted: SpawnSyncReturns<string>;
  if (w.merged === w.head) {
    script(w, [...prechecks(w), post(w), { ...prStep(w), interrupt: true }]);
    interrupted = child(w, { ...request(w), op: "merge" });
  } else {
    retainLegacyAttempt(w);
    script(w, [{ ...prStep(w), interrupt: true }]);
    interrupted = child(w, { op: "reconcile-merge", number: ISSUE });
  }
  return { interrupted, saved: readWriteState(w.cfg, ISSUE) };
}

function mergeComment(w: World): { args: string[] } {
  return {
    args: [
      "api",
      "-X",
      "POST",
      `repos/${REPO}/issues/${PR}/comments`,
      "-f",
      `body=${signed({ role: "merger" }, `${mergedText(w.state, w.head, w.merged)}\n\n`)}`,
      "--silent",
    ],
  };
}

export {
  child,
  confirmation,
  expectedTargetPush,
  interruptAfterResponse,
  mergeComment,
  posts,
  retainLegacyAttempt,
  staleConfirmation,
};
