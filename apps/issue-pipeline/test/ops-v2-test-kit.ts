// The version 2 core ops' fixtures: the ops CLI harness
// (ops-cli-test-kit.ts, which sets a temporary HOME and pipeline root before
// any pipeline module loads) on a fake gh, version 2 states, GitHub's PR
// views, and the states and comments the ops wrote.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GhReply } from "./fake-gh.ts";
import { ownerReceipt } from "./fake-ownership.ts";
import { stopMutationReplies } from "./gh-mutation-fixtures.ts";

const kit: typeof import("./ops-cli-test-kit.ts") = await import(
  "./ops-cli-test-kit.ts"
);

const { ALLOWED, root, sh, writes }: typeof import("./ops-cli-test-kit.ts") =
  kit;

const STATE_JSON = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const STATE_GROUPS = z.object({ json: z.string() });
// The length of a full git object id.
const SHA_LENGTH = 40;
const LIVE = new Date().toISOString();
const LANE = { lane: "me", sweepId: "s1" };

// A version 2 state for issue `n`, with `extra` over a new issue's.
function v2State(n: number, extra: object = {}): Record<string, unknown> {
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
function prView(n: number, pr: number, extra: object = {}): GhReply {
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
function openIssue(n: number): GhReply {
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
function everyCommentsRead(n: number, comments: readonly unknown[]): GhReply {
  return { ...kit.commentsReply(n, comments), keep: true };
}

// The state a bound claim checkpoints before it derives the claimed state
// (#167): `saved` with its owner's receipt and the branch it binds. A
// refused claim writes only this.
function receiptCheckpoint(saved: {
  number?: unknown;
  [field: string]: unknown;
}): Record<string, unknown> {
  const branch = `agent/issue-${String(saved.number)}`;
  return { ...saved, branch, execution: ownerReceipt() };
}

// The states the ops wrote, in order.
function savedStates(): unknown[] {
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
function commitOnOrigin(branch: string, file: string): string {
  return sh(
    `cd ${root}/seed && git checkout -q -B ${branch} origin/integration 2>/dev/null || git checkout -q -B ${branch} integration; echo ${file} > ${file} && git add ${file} && git commit -qm ${file} && git push -qf origin HEAD:refs/heads/${branch} && git rev-parse HEAD`,
  );
}

// Records `sha` as the pipeline's own push of issue `n`'s branch by `op`.
function recordPipelinePush(n: number, sha: string, op: string): void {
  const dir = kit.runDir(n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pushed.json"),
    JSON.stringify({ sha, op, at: LIVE }),
  );
}

// A claim comment of this lane, live.
function myClaim(id: number): object {
  return kit.claimComment(id, LANE.lane, LANE.sweepId, LIVE);
}

// The ops read the clone a sweep used to make.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

function reviewStopReplies(n: number, pr: number, claim: number): void {
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
