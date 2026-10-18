// @ts-check
// Shared setup for the tests that run an op through the ops CLI as the
// workflow does: a pipeline root with a config, local git repos holding issue
// #7's worktree, the fake gh, and the exact gh writes and comment texts the
// finishing ops make.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { githubComment, installFakeGh } from "./fake-gh.mjs";
import { runOps, setEnv } from "./ops-run-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @typedef {{ config: string, root: string, sha: string, worktree: string }} World */
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

// This process's pipeline modules read a temporary root and HOME, set before
// any of them loads; each world's ops child gets the world's own.
const kitRoot = fs.mkdtempSync("/tmp/issue-pipeline-ops-kit-");
process.on("exit", () => fs.rmSync(kitRoot, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", kitRoot);
setEnv("HOME", kitRoot);
const pipelineRoot = await import("../src/pipeline-root.ts");
if (pipelineRoot.ROOT !== kitRoot || pipelineRoot.HOME !== kitRoot) {
  throw new Error("the pipeline root isn't the ops tests' temporary folder");
}
const { ghIsRead } = await import("../src/github.ts");

const fakeGh = installFakeGh();

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// An ISO time `hours` from now; negative is in the past.
/** @param {number} hours @returns {string} */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * MS_PER_HOUR).toISOString();
}

// A fresh pipeline root with a config, a bare origin whose `integration` has
// one commit, the clone, and issue #7's worktree on agent/issue-7 one commit
// ahead. Returns the root, the config path, the worktree and its head.
/** @returns {World} */
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
/** @param {World} w @returns {void} */
function advanceBase(w) {
  sh(
    `cd ${w.root}/seed && git ${GIT_USER} commit -q --allow-empty -m later && git push -q origin HEAD:integration`,
  );
}

/**
 * Runs one request through the ops CLI, src/ops.ts unless `ops` names another
 * (a built one), and returns its stdout.
 * @param {World} w
 * @param {object} request
 * @param {string} [ops]
 * @returns {string}
 */
function ask(w, request, ops) {
  const where = { config: w.config, request, root: w.root, home: w.root };
  if (ops === undefined) {
    return runOps(where);
  }
  return runOps({ ...where, ops });
}

// The exact line an op prints for the reply `want`, which pins the key order.
/** @param {unknown} want @returns {string} */
function replyLine(want) {
  return `${JSON.stringify(want)}\n`;
}

// The gh calls since the last reply(), with minute stamps made constant.
/** @returns {string[][]} */
function calls() {
  return fakeGh
    .calls()
    .map((args) => args.map((arg) => arg.replace(MINUTE_STAMP, "<minute>")));
}

// The calls since the last reply() that change GitHub, by src/github.ts's own
// read/write rule; reads are how an op finds things out, not what it does.
/** @returns {string[][]} */
function writes() {
  return calls().filter((args) => !ghIsRead(args));
}

/** @param {string} role @param {string} text @returns {string} */
function signedBy(role, text) {
  return `**🤖 issue-pipeline · ${role}**\n<sub>deterministic step, no model</sub>\n<!-- agent-pipeline:comment role=${role} -->\n\n${text}`;
}

/** @param {number} n @param {object} state @returns {string} */
function stateBody(n, state) {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #${n}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

/** @param {number} n @param {string} body @returns {string[]} */
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

/** @param {number} n @returns {string[]} */
function listCall(n) {
  return [
    "api",
    "--paginate",
    `repos/${REPO}/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

/** @param {number} id @param {string} body @returns {string[]} */
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

/**
 * gh's answer to listing #7's comments: this lane's live claim.
 * @returns {GhReply}
 */
function claimListing() {
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

/**
 * gh's answer to listing #n's comments: one state comment holding `state`.
 * @param {number} n
 * @param {object} state
 * @returns {GhReply}
 */
function stateListing(n, state) {
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

/** @param {number} n @param {string} add @param {string} remove @returns {string[][]} */
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
/** @returns {GhReply[]} */
function finishReplies() {
  return [
    claimListing(),
    claimListing(),
    { when: "--jq {state}", stdout: '{"state":"open"}' },
  ];
}

// The gh writes finishMerged makes for issue #7 and PR #50, in order, with
// `published`, the writes the wiki publish makes, between the PR's labels and
// the issue's.
/** @param {object} state @param {string[][]} [published] @returns {string[][]} */
function finishWrites(state, published = []) {
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
