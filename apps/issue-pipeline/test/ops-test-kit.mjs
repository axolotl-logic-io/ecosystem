// Shared setup for the tests that run an op through the ops CLI as the
// workflow does: a pipeline root with a config, local git repos holding issue
// #7's worktree, the fake gh, and the exact gh calls and comment texts the
// finishing ops make.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { installFakeGh } from "./fake-gh.mjs";

const OPS = new URL("../src/ops.mjs", import.meta.url).pathname;
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
const CONFIG = {
  repo: REPO,
  account: ACCOUNT,
  allowedUsers: ["alice"],
  commands: { test: "true" },
  baseBranch: "integration",
};
const GIT_USER = "-c user.email=a@b -c user.name=a";

const fakeGh = installFakeGh();

function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// An ISO time `hours` from now; negative is in the past.
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * MS_PER_HOUR).toISOString();
}

// A fresh pipeline root with a config, a bare origin whose `integration` has
// one commit, the clone, and issue #7's worktree on agent/issue-7 one commit
// ahead. Returns the root, the config path, the worktree and its head.
function world() {
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
function advanceBase(w) {
  sh(
    `cd ${w.root}/seed && git ${GIT_USER} commit -q --allow-empty -m later && git push -q origin HEAD:integration`,
  );
}

// Runs one request through the ops CLI, src/ops.mjs unless `ops` names another
// (a built one), and returns its stdout.
function ask(w, request, ops = OPS) {
  const body = JSON.stringify({ config: w.config, ...request });
  const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${body}\nEND_OPS_REQUEST`;
  const r = spawnSync(process.execPath, [ops], {
    input,
    encoding: "utf8",
    env: { ISSUE_PIPELINE_ROOT: w.root, PATH: process.env.PATH },
  });
  if (r.status !== 0) {
    throw new Error(`ops exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

// The reply, both parsed and as the exact line, which pins the key order.
function assertReply(stdout, want) {
  assert.deepEqual(JSON.parse(stdout), want);
  assert.equal(stdout, `${JSON.stringify(want)}\n`);
}

// The gh calls since the last reply(), with minute stamps made constant.
function calls() {
  return fakeGh
    .calls()
    .map((args) => args.map((arg) => arg.replace(MINUTE_STAMP, "<minute>")));
}

function signedBy(role, text) {
  return `**🤖 issue-pipeline · ${role}**\n<sub>deterministic step, no model</sub>\n<!-- agent-pipeline:comment role=${role} -->\n\n${text}`;
}

function stateBody(n, state) {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #${n}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

function commentPost(n, body) {
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

function listCall(n) {
  return [
    "api",
    "--paginate",
    `repos/${REPO}/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

function patchComment(id, body) {
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
function claimListing() {
  const at = new Date().toISOString();
  const claim = {
    id: CLAIM_ID,
    body: CLAIM_BODY,
    user: { login: ACCOUNT },
    created_at: at,
    updated_at: at,
  };
  return { when: "issues/7/comments?per_page", stdout: JSON.stringify(claim) };
}

// gh's answer to listing #n's comments: one state comment holding `state`.
function stateListing(n, state) {
  const item = {
    id: n,
    body: stateBody(n, state),
    user: { login: ACCOUNT },
    created_at: new Date().toISOString(),
  };
  return {
    when: `issues/${n}/comments?per_page`,
    stdout: JSON.stringify(item),
  };
}

function relabel(n, add, remove) {
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
function finishReplies() {
  return [
    claimListing(),
    claimListing(),
    { when: "--jq {state}", stdout: '{"state":"open"}' },
  ];
}

// The gh calls finishMerged makes for issue #7 and PR #50.
function finishCalls(state) {
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
    listCall(ISSUE),
    commentPost(
      ISSUE,
      stateBody(ISSUE, { ...state, stage: "done", lease: null }),
    ),
    ...relabel(ISSUE, "agent:merged", "agent:working"),
    ["api", `repos/${REPO}/issues/${ISSUE}/labels`],
    ...relabel(PR, "agent:merged", "agent:working"),
    ["api", `repos/${REPO}/issues/${PR}/labels`],
    listCall(ISSUE),
    patchComment(CLAIM_ID, `${closed}\n\nClosed <minute>: PR #50 merged.`),
    ["api", `repos/${REPO}/issues/7`, "--jq", "{state}"],
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

export {
  advanceBase,
  ask,
  assertReply,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  finishCalls,
  finishReplies,
  GIT_USER,
  hoursFromNow,
  LANE,
  listCall,
  relabel,
  SWEEP,
  sh,
  signedBy,
  stateBody,
  stateListing,
  world,
};
