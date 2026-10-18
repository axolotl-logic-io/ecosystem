// The claim op with the wiki on: it readies the issue's wiki checkout at the
// wiki's agent/issue-<n>, so a stopped issue whose only work is on the wiki
// resumes the stage it stopped at with that work. (Version 2 saves the stage
// a stop came from, so the claim no longer infers review from wiki commits.)

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { effectNames, stateOf } from "./gh-effects.mjs";
import { claimMutationReplies } from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import { issueReply, LANE, LIVE } from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  configWith,
  effects,
  reply,
  requireGhReplies,
  root,
  sh,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

import { addSubmodule } from "./submodule-test-kit.mjs";

requireGhReplies();

const { newIssueState } = await import("../src/state.ts");

const ISSUE = 46;
// The ids of the issue's claim and state comments.
const CLAIM_ID = 16;
const STATE_ID = 17;
// The part of a claim's reply these tests read. The state is a record, which
// keeps its key order for the state comment the claim wrote.
const CLAIM_REPLY = z.object({
  ok: z.literal(true),
  state: z.record(z.string(), z.unknown()),
  paths: z.looseObject({ wiki: z.string() }),
});

// The clone a sweep used to make, which a claim reads.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// A wiki origin with a master seed commit, and its agent/issue-<n> one commit
// ahead; returns the wiki config and that commit.
/** @param {number} n @returns {{ config: string, sha: string }} */
function wikiAheadOnBranch(n) {
  const origin = path.join(root, "wiki.git");
  const seed = path.join(root, "wiki-seed");
  sh(`git init -q --bare -b master ${origin}`);
  sh(`git clone -q ${origin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(`cd ${seed} && echo home > Home.md && git add . && git commit -qm home`);
  sh(`cd ${seed} && git push -q origin HEAD:master`);
  sh(`cd ${seed} && echo page > Page.md && git add . && git commit -qm page`);
  sh(`cd ${seed} && git push -q origin HEAD:refs/heads/agent/issue-${n}`);
  addSubmodule(path.join(root, "seed"), origin);
  sh(`git -C ${root}/seed push -q origin integration`);
  sh(
    `git -C ${root}/clones/o__r fetch -q origin && git -C ${root}/clones/o__r reset --hard origin/integration`,
  );
  sh(`git -C ${root}/clones/o__r submodule update --init --recursive`);
  const config = configWith({ wiki: true });
  return { config, sha: sh(`git -C ${seed} rev-parse HEAD`) };
}

test("a claim lifts a stopped issue with only wiki work to its stage, with the wiki checkout at its branch", () => {
  const { config, sha } = wikiAheadOnBranch(ISSUE);
  const comments = [
    claimComment(CLAIM_ID, "me", "s0", LIVE),
    stateComment(STATE_ID, {
      ...newIssueState(ISSUE),
      stage: "stopped",
      stoppedStage: "review",
      stopCode: "wiki-check",
      flows: { code: false, wiki: true },
      log: [`${TIME} stopped (wiki-check)`],
    }),
  ];
  reply([
    historyReply(ISSUE),
    issueReply(ISSUE, { labels: [{ name: "agent:stopped-wiki-check" }] }),
    commentsReply(ISSUE, comments),
    commentsReply(ISSUE, comments),
    ...claimMutationReplies(ISSUE, STATE_ID, null, [
      "agent:stopped-wiki-check",
    ]),
  ]);
  const out = CLAIM_REPLY.parse(
    askOps({ op: "claim", config, number: ISSUE, ...LANE }),
  );
  assert.equal(out.ok, true);
  const { stage, stopCode, flows } = out.state;
  assert.deepEqual(
    [stage, stopCode, flows],
    ["review", null, { code: false, wiki: true }],
  );
  const wiki = path.join(worktree(ISSUE), "wiki");
  assert.equal(out.paths.wiki, wiki);
  assert.equal(sh(`git -C ${wiki} rev-parse HEAD`), sha);
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${STATE_ID} state`,
    `label #${ISSUE} agent:working`,
    `unlabel #${ISSUE} agent:needs-info`,
    `unlabel #${ISSUE} agent:stopped-wiki-check`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${STATE_ID} state`),
    out.state,
  );
});
