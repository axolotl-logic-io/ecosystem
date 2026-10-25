// Exact supported GitHub calls for the private explicit-target fixture.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueState, Revision } from "../src/state.ts";
import type { World } from "./explicit-target-world-test-kit.ts";
import {
  BRANCH,
  HOME,
  ISSUE,
  ISSUE_DATA,
  PR,
  REPO,
} from "./explicit-target-world-test-kit.ts";

interface GhStep {
  args: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
  updates?: [string, string][];
  interrupt?: boolean;
  skipMutation?: boolean;
}
// The merge op's request for the world's PR.
interface MergeRequest {
  number: number;
  state: IssueState;
  revision: Revision;
  expectedSha: string;
  expectedBase: string;
  mergeQueue: null;
}
const CALLS = z.array(z.array(z.string()));
const REMAINING = z.object({ steps: z.array(z.unknown()) });
const VIEW_FIELDS =
  "number,isCrossRepository,baseRefName,headRefName,headRefOid,state,mergeable,mergeStateStatus,isDraft,mergeCommit,url";
const RECEIPT_FIELDS =
  "number,state,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository";

function view(
  w: World,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url: `https://github.com/${REPO}/pull/${PR}`,
    number: PR,
    state: "OPEN",
    headRefName: BRANCH,
    headRefOid: w.head,
    baseRefName: w.cfg.baseBranch,
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    ...extra,
  };
}
function prStep(
  w: World,
  extra: Record<string, unknown> = {},
  receipt = false,
): GhStep {
  let fields = VIEW_FIELDS;
  if (receipt) {
    fields = RECEIPT_FIELDS;
  }
  return {
    args: ["pr", "view", String(PR), "-R", REPO, "--json", fields],
    stdout: JSON.stringify(view(w, extra)),
  };
}
function prechecks(w: World): GhStep[] {
  return [
    prStep(w),
    {
      args: ["api", `repos/${REPO}/issues/${ISSUE}`],
      stdout: JSON.stringify(ISSUE_DATA),
    },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    prStep(w, {}, true),
    prStep(w),
    ...candidateInputs(w),
    {
      args: [
        "api",
        `repos/${REPO}/pulls/${PR}/reviews`,
        "--method",
        "POST",
        "-f",
        "event=APPROVE",
        "-f",
        `commit_id=${w.head}`,
        "--jq",
        "{state, commit: .commit_id, login: .user.login}",
      ],
      stdout: JSON.stringify({
        state: "APPROVED",
        commit: w.head,
        login: w.cfg.mergeAccount,
      }),
    },
  ];
}
function candidateInputs(w: World): GhStep[] {
  return [
    {
      args: ["api", `repos/${REPO}/issues/${ISSUE}`],
      stdout: JSON.stringify(ISSUE_DATA),
    },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    prStep(w, {}, true),
  ];
}
function resultInputs(w: World): GhStep[] {
  return [
    {
      args: ["api", `repos/${REPO}/issues/${ISSUE}`],
      stdout: JSON.stringify(ISSUE_DATA),
    },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    prStep(w, mergedView(w), true),
  ];
}
function post(w: World, extra: Partial<GhStep> = {}): GhStep {
  return {
    args: [
      "-C",
      w.wt,
      "-c",
      "push.followTags=false",
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/${w.cfg.baseBranch}:${w.base}`,
      "origin",
      `${w.head}:refs/heads/${w.cfg.baseBranch}`,
    ],
    ...extra,
  };
}
function mergedView(w: World): Record<string, unknown> {
  return { state: "MERGED", mergeCommit: { oid: w.merged } };
}
function script(w: World, steps: GhStep[], preserveCalls = false): void {
  fs.writeFileSync(
    path.join(HOME, "gh-script.json"),
    JSON.stringify({ origin: w.origin, steps }),
  );
  if (!preserveCalls) {
    fs.writeFileSync(path.join(HOME, "gh-calls.jsonl"), "");
  }
}
function calls(): string[][] {
  const text = fs
    .readFileSync(path.join(HOME, "gh-calls.jsonl"), "utf8")
    .trim();
  if (text === "") {
    return [];
  }
  return CALLS.parse(text.split("\n").map((line) => JSON.parse(line)));
}
function consumed(): void {
  const remaining = REMAINING.parse(
    JSON.parse(fs.readFileSync(path.join(HOME, "gh-script.json"), "utf8")),
  );
  if (remaining.steps.length > 0) {
    throw new Error("not all explicitly supported gh calls were consumed");
  }
}
function request(w: World): MergeRequest {
  return {
    number: ISSUE,
    state: w.state,
    revision: w.revision,
    expectedSha: w.head,
    expectedBase: w.base,
    mergeQueue: null,
  };
}

export type { GhStep, MergeRequest };
export {
  calls,
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  resultInputs,
  script,
  view,
};
