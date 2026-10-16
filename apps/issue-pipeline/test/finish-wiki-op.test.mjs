// @ts-check
// finish-wiki (#217): a change that lives only in the wiki is finished in
// place of a merge. It publishes #7's wiki commits, closes the issue as
// completed with a signed merger comment that lists them, labels it
// agent:merged and deletes the code branch; a conflict leaves the issue open
// with the conflict in the reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ask,
  fakeGh,
  finishReplies,
  hoursFromNow,
  LANE,
  replyLine,
  SWEEP,
  sh,
  world,
  writes,
} from "./ops-test-kit.mjs";
import { withWiki } from "./wiki-test-kit.mjs";

const ISSUE = 7;
const SHORT_SHA = 12;
const STATE = {
  pr: 50,
  stage: "merge",
  flows: { code: false, wiki: true },
  prClosed: true,
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};
const MERGER = /agent-pipeline:comment role=merger/u;
const MERGED_LABEL = "labels[]=agent:merged";

/** @param {readonly string[]} args @returns {boolean} */
function closesIssue(args) {
  const [command, verb, number] = args;
  return command === "issue" && verb === "close" && number === String(ISSUE);
}

test("finish-wiki publishes the wiki commits, closes the issue listing them and labels it merged", () => {
  const w = world();
  const wiki = withWiki(w);
  fakeGh.reply(finishReplies());
  const out = ask(w, { op: "finish-wiki", number: ISSUE, state: STATE });
  const sha = sh(`git -C ${wiki.origin} rev-parse master`);
  const commits = [`${sha.slice(0, SHORT_SHA)} page`];
  const reply = { merged: true, published: true, sha, commits };
  assert.equal(
    out,
    replyLine({ ok: true, op: "finish-wiki", posted: 0, ...reply }),
  );
  const done = writes();
  const close = done.find(closesIssue) ?? [];
  const comment = close.at(close.indexOf("--comment") + 1) ?? "";
  assert.match(comment, MERGER);
  assert.ok(comment.includes(`- ${sha.slice(0, SHORT_SHA)} page`));
  assert.ok(close.includes("completed"));
  const labelled = done.find((args) => args.includes(MERGED_LABEL)) ?? [];
  assert.ok(labelled.some((arg) => arg.endsWith(`issues/${ISSUE}/labels`)));
  const deleted = `repos/o/r/git/refs/heads/agent/issue-${ISSUE}`;
  assert.ok(
    done.some((args) => args.includes("DELETE") && args.includes(deleted)),
  );
});

test("finish-wiki leaves a conflicting wiki publish open, with the conflict in its reply", () => {
  const w = world();
  withWiki(w, { conflict: true });
  fakeGh.reply(finishReplies());
  const out = JSON.parse(
    ask(w, { op: "finish-wiki", number: ISSUE, state: STATE }),
  );
  assert.deepEqual(
    { merged: out.merged, published: out.published, conflict: out.conflict },
    { merged: true, published: false, conflict: true },
  );
  assert.equal(writes().some(closesIssue), false);
});
