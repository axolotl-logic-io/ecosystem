// @ts-check
// The version 2 core ops' fixtures: the ops CLI harness
// (ops-cli-test-kit.mjs, which sets a temporary HOME and pipeline root before
// any pipeline module loads) on a fake gh, version 2 states, GitHub's PR
// views, and the states and comments the ops wrote.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ownerReceipt } from "./fake-ownership.mjs";
import { stopMutationReplies } from "./gh-mutation-fixtures.mjs";

const kit = await import("./ops-cli-test-kit.mjs");

const { ALLOWED, root, sh, writes } = kit;

const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const STATE_GROUPS = z.object({ json: z.string() });
// The length of a full git object id.
const SHA_LENGTH = 40;
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
    branch: null,
    headSha: null,
    flows: null,
    gherkin: null,
    authorUsed: true,
    requirementsInputs: null,
    review: {
      round: 0,
      verdict: null,
      commentId: null,
      findings: [],
      revision: null,
    },
    hardened: null,
    hardenedTarget: null,
    integration: null,
    security: null,
    verifiedSha: null,
    mergeReturn: null,
    merged: null,
    codeMerged: null,
    mergeAttempt: null,
    asked: null,
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
    headRefOid: "0".repeat(SHA_LENGTH),
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
    user: { login: ALLOWED },
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

// The state a bound claim checkpoints before it derives the claimed state
// (#167): `saved` with its owner's receipt and the branch it binds. A
// refused claim writes only this.
/** @param {{ number?: unknown, [field: string]: unknown }} saved @returns {Record<string, unknown>} */
function receiptCheckpoint(saved) {
  const branch = `agent/issue-${String(saved.number)}`;
  return { ...saved, branch, execution: ownerReceipt() };
}

// The states the ops wrote, in order.
/** @returns {unknown[]} */
function savedStates() {
  return writes().flatMap((args) => {
    const body = args.find((arg) => arg.startsWith("body="));
    const groups = STATE_GROUPS.safeParse(STATE_JSON.exec(body ?? "")?.groups);
    if (!groups.success) {
      return [];
    }
    return [JSON.parse(groups.data.json)];
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

/** @param {number} n @param {number} pr @param {number} claim @returns {void} */
function reviewStopReplies(n, pr, claim) {
  const prior = kit.stateComment(n, v2State(n, { stage: "review", pr }));
  kit.reply([
    {
      when: `api -X DELETE repos/o/r/issues/${n}/labels/agent%3Astopped-error --silent`,
      stdout: "",
    },
    {
      when: `issues/${n}/labels`,
      stdout: JSON.stringify([{ name: "agent:stopped-error" }]),
    },
    {
      ...kit.commentsReply(n, [myClaim(claim), prior]),
      persistState: true,
      keep: true,
    },
    ...stopMutationReplies(n, {
      stateId: n,
      pr,
      code: "review-rounds",
      claims: [claim],
    }),
  ]);
}

export {
  commitOnOrigin,
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  receiptCheckpoint,
  recordPipelinePush,
  reviewStopReplies,
  savedStates,
  v2State,
};
