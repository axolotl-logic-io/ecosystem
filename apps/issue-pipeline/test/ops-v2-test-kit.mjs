// @ts-check
// The version 2 core ops' fixtures: a temporary HOME and pipeline root set
// before any pipeline module loads, the ops CLI harness (ops-cli-test-kit.mjs)
// on a fake gh, version 2 states, GitHub's PR views, and the states and
// comments the ops wrote.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setEnv } from "./ops-run-test-kit.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-v2-home-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
setEnv("HOME", home);
setEnv("ISSUE_PIPELINE_ROOT", path.join(home, "root"));

const kit = await import("./ops-cli-test-kit.mjs");
const { ACCOUNT, root, sh, writes } = kit;

const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const LIVE = new Date().toISOString();
const LANE = { lane: "me", sweepId: "s1" };

// A version 2 state for issue `n`, with `extra` over a new issue's.
/** @param {number} n @param {object} [extra] @returns {Record<string, unknown>} */
function v2State(n, extra = {}) {
  return {
    version: 2,
    number: n,
    stage: "implement",
    stoppedStage: null,
    stopCode: null,
    resumeStage: null,
    lease: null,
    pr: null,
    headSha: null,
    flows: null,
    gherkin: null,
    review: {
      round: 0,
      verdict: null,
      commentId: null,
      findings: [],
      revision: null,
    },
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    counts: { conflictFixes: 0, syncs: 0 },
    log: [],
    ...extra,
  };
}

// gh's reply to `gh pr view <pr> --json ...` for issue `n`'s PR, with
// `extra` over an open PR from agent/issue-<n> into integration at `head`.
/** @param {number} n @param {number} pr @param {object} [extra] @returns {import("./fake-gh.mjs").GhReply} */
function prView(n, pr, extra = {}) {
  const view = {
    number: pr,
    state: "OPEN",
    mergeCommit: null,
    headRefName: `agent/issue-${n}`,
    headRefOid: "0".repeat(40),
    baseRefName: "integration",
    isCrossRepository: false,
    ...extra,
  };
  return { when: `pr view ${pr} `, stdout: JSON.stringify(view), keep: true };
}

// gh's reply to getIssue for issue `n`: open and unlabelled.
/** @param {number} n @returns {import("./fake-gh.mjs").GhReply} */
function openIssue(n) {
  const issue = {
    number: n,
    title: `Issue ${n}`,
    body: "",
    state: "open",
    user: { login: ACCOUNT },
    labels: [],
  };
  return {
    when: `api repos/o/r/issues/${n}`,
    stdout: JSON.stringify(issue),
    keep: true,
  };
}

// gh's reply to every read of issue `n`'s comments: `comments`.
/** @param {number} n @param {readonly unknown[]} comments @returns {import("./fake-gh.mjs").GhReply} */
function everyCommentsRead(n, comments) {
  return { ...kit.commentsReply(n, comments), keep: true };
}

// The states the ops wrote, in order.
/** @returns {unknown[]} */
function savedStates() {
  return writes().flatMap((args) => {
    const body = args.find((arg) => arg.startsWith("body="));
    const json = STATE_JSON.exec(body ?? "")?.groups?.json;
    if (json === undefined) {
      return [];
    }
    return [JSON.parse(json)];
  });
}

// Commits a file on the bare origin's `branch`, from the base, and returns
// the new head.
/** @param {string} branch @param {string} file @returns {string} */
function commitOnOrigin(branch, file) {
  return sh(
    `cd ${root}/seed && git checkout -q -B ${branch} origin/integration 2>/dev/null || git checkout -q -B ${branch} integration; echo ${file} > ${file} && git add ${file} && git commit -qm ${file} && git push -qf origin HEAD:refs/heads/${branch} && git rev-parse HEAD`,
  );
}

// Records `sha` as the pipeline's own push of issue `n`'s branch by `op`.
/** @param {number} n @param {string} sha @param {string} op @returns {void} */
function recordPipelinePush(n, sha, op) {
  const dir = kit.runDir(n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pushed.json"),
    JSON.stringify({ sha, op, at: LIVE }),
  );
}

// A claim comment of this lane, live.
/** @param {number} id @returns {object} */
function myClaim(id) {
  return kit.claimComment(id, LANE.lane, LANE.sweepId, LIVE);
}

// The ops read the clone a sweep used to make.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

export {
  commitOnOrigin,
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  recordPipelinePush,
  savedStates,
  v2State,
};
