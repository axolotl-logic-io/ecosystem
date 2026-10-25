// Shared setup for the tests that run an op through the ops CLI as the
// workflow does: a pipeline root with a config, local git repos holding issue
// #7's worktree, the fake gh, and the exact gh writes and comment texts the
// finishing ops make.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "../credentials-test-kit.ts";
import type { GhReply } from "../fake-gh.ts";
import { githubComment, installFakeGh } from "../fake-gh.ts";
import { runOps, setEnv } from "../ops-run-test-kit.ts";

interface World {
  config: string;
  root: string;
  sha: string;
  worktree: string;
}
const ACCOUNT = "bot";
const REPO = "o/r";
const LANE = "L";
const SWEEP = "s1";
const CLAIM_ID = 501;
// The issue every test works on, and its PR.
const ISSUE = 7;
const PR = 50;
const MS_PER_HOUR = 3_600_000;
const MINUTE_STAMP = /\d{4}-\d\d-\d\dT\d\d:\d\dZ/gu;
const CONFIG: {
  allowedUsers: string[];
  commands: { test: string };
  baseBranch: string;
  devAccount: string;
  mergeAccount: string;
  credentialsEnvFile: string;
  repo: string;
} = {
  repo: REPO,
  ...credentialConfig(ACCOUNT),
  allowedUsers: ["alice"],
  commands: { test: "true" },
  baseBranch: "integration",
};
const GIT_USER = "-c user.email=a@b -c user.name=a";

// This process's pipeline modules read a temporary root and HOME, set before
// any of them loads; each world's ops child gets the world's own.
const kitRoot = fs.mkdtempSync("/tmp/issue-pipeline-ops-kit-");
process.on("exit", () => fs.rmSync(kitRoot, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", kitRoot);
setEnv("HOME", kitRoot);
const pipelineRoot: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
if (pipelineRoot.ROOT !== kitRoot || pipelineRoot.HOME !== kitRoot) {
  throw new Error("the pipeline root isn't the ops tests' temporary folder");
}
const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);

const fakeGh = installFakeGh();

function sh(command: string): string {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// An ISO time `hours` from now; negative is in the past.
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * MS_PER_HOUR).toISOString();
}

// A fresh pipeline root with a config, a bare origin whose `integration` has
// one commit, the clone, and issue #7's worktree on agent/issue-7 one commit
// ahead. Returns the root, the config path, the worktree and its head.
function world(): World {
  const root = fs.mkdtempSync("/tmp/issue-pipeline-ops-");
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify(CONFIG));
  const worktree = path.join(root, "work/o__r/issue-7");
  const clone = path.join(root, "clones/o__r");
  sh(
    `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null && cd seed && git ${GIT_USER} commit -q --allow-empty -m base && git push -q origin HEAD:integration`,
  );
  sh(
    `git clone -q ${root}/origin.git ${clone} && git -C ${clone} worktree add -q -b agent/issue-7 ${worktree} origin/integration && git -C ${worktree} ${GIT_USER} commit -q --allow-empty -m work`,
  );
  const sha = sh(`git -C ${worktree} rev-parse HEAD`);
  return { config, root, sha, worktree };
}

// Origin's integration gains a commit the worktree's head lacks.
function advanceBase(w: World): void {
  sh(
    `cd ${w.root}/seed && git ${GIT_USER} commit -q --allow-empty -m later && git push -q origin HEAD:integration`,
  );
}

// Runs one request through the ops CLI, src/ops.ts unless `ops` names another
// (a built one), and returns its stdout.
function ask(w: World, request: object, ops?: string): string {
  const where = { config: w.config, request, root: w.root, home: w.root };
  if (ops === undefined) {
    return runOps(where);
  }
  return runOps({ ...where, ops });
}

// The exact line an op prints for the reply `want`, which pins the key order.
function replyLine(want: unknown): string {
  return `${JSON.stringify(want)}\n`;
}

// The gh calls since the last reply(), with minute stamps made constant.
function calls(): string[][] {
  return fakeGh
    .calls()
    .map((args) => args.map((arg) => arg.replace(MINUTE_STAMP, "<minute>")));
}

// The calls since the last reply() that change GitHub, by src/github.ts's own
// read/write rule; reads are how an op finds things out, not what it does.
function writes(): string[][] {
  return calls().filter((args) => !ghIsRead(args));
}

function signedBy(role: string, text: string): string {
  return `**🤖 issue-pipeline · ${role}**\n<sub>deterministic step, no model</sub>\n<!-- agent-pipeline:comment role=${role} -->\n\n${text}`;
}

function stateBody(n: number, state: object): string {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #${n}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

function commentPost(n: number, body: string): string[] {
  return [
    "api",
    "-X",
    "POST",
    `repos/${REPO}/issues/${n}/comments`,
    "-f",
    `body=${body}`,
    "--silent",
  ];
}

function listCall(n: number): string[] {
  return [
    "api",
    "--paginate",
    `repos/${REPO}/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

function patchComment(id: number, body: string): string[] {
  return [
    "api",
    "-X",
    "PATCH",
    `repos/${REPO}/issues/comments/${id}`,
    "-f",
    `body=${body}`,
    "--silent",
  ];
}

const CLAIM_BODY = `${signedBy("claim", `Lane \`${LANE}\` is claiming this issue.`)}\n<!-- agent-pipeline:claim lane=${LANE} sweep=${SWEEP} -->`;

// gh's answer to listing #7's comments: this lane's live claim.
function claimListing(): GhReply {
  const at = new Date().toISOString();
  const claim = githubComment({
    id: CLAIM_ID,
    body: CLAIM_BODY,
    login: ACCOUNT,
    created: at,
    updated: at,
  });
  return { when: "issues/7/comments?per_page", stdout: JSON.stringify(claim) };
}

// gh's answer to listing #n's comments: one state comment holding `state`.
function stateListing(n: number, state: object): GhReply {
  const item = githubComment({
    id: n,
    body: stateBody(n, state),
    login: ACCOUNT,
    created: new Date().toISOString(),
  });
  return {
    when: `issues/${n}/comments?per_page`,
    stdout: JSON.stringify(item),
  };
}

function relabel(n: number, add: string, remove: string): string[][] {
  return [
    [
      "api",
      "-X",
      "DELETE",
      `repos/${REPO}/issues/${n}/labels/${encodeURIComponent(remove)}`,
      "--silent",
    ],
    [
      "api",
      "-X",
      "POST",
      `repos/${REPO}/issues/${n}/labels`,
      "--silent",
      "-f",
      `labels[]=${add}`,
    ],
  ];
}

// The replies finishMerged reads: #7's comments (for the state write and the
// claims) and #7's open state.
function finishReplies(): GhReply[] {
  return [
    claimListing(),
    claimListing(),
    { when: "--jq {state}", stdout: '{"state":"open"}' },
  ];
}

// The gh writes finishMerged makes for issue #7 and PR #50, in order, with
// `published`, any additional completion writes, between the PR's labels and
// the issue's.
function finishWrites(state: object, published: string[][] = []): string[][] {
  const closed = CLAIM_BODY.replace(
    `agent-pipeline:claim lane=${LANE}`,
    `agent-pipeline:claim-closed lane=${LANE}`,
  );
  return [
    [
      "api",
      "-X",
      "DELETE",
      `repos/${REPO}/git/refs/heads/agent/issue-7`,
      "--silent",
    ],
    ...relabel(PR, "agent:merged", "agent:working"),
    ...published,
    commentPost(
      ISSUE,
      stateBody(ISSUE, { ...state, stage: "done", lease: null }),
    ),
    ...relabel(ISSUE, "agent:merged", "agent:working"),
    patchComment(CLAIM_ID, `${closed}\n\nClosed <minute>: PR #50 merged.`),
    [
      "issue",
      "close",
      "7",
      "-R",
      REPO,
      "--reason",
      "completed",
      "--comment",
      "PR #50 merged into integration.",
    ],
  ];
}

export type { World };
export {
  advanceBase,
  ask,
  CLAIM_ID,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  finishReplies,
  finishWrites,
  GIT_USER,
  hoursFromNow,
  ISSUE,
  LANE,
  listCall,
  REPO,
  relabel,
  replyLine,
  SWEEP,
  sh,
  signedBy,
  stateBody,
  stateListing,
  world,
  writes,
};
