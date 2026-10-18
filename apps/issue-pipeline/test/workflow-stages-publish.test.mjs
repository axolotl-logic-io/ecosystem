// @ts-check
// The publish stage through the sweep (#216): a merge whose wiki changes hit a
// conflict moves to publish in the same sweep, where the conflict resolver
// settles the wiki's rebase and the issue's wiki commits are published.
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFor, sessionAgents } from "./stage-outcome-test-kit.mjs";
import {
  finishRun,
  issueSummary,
  SECURED,
} from "./workflow-finish-run-kit.mjs";
import { ISSUE, replyWith } from "./workflow-stages-fixtures.mjs";

const CONFLICT = {
  ok: true,
  published: false,
  conflict: true,
  inRebase: true,
  conflicts: ["Home.md"],
  baseSha: "abcdefabcdef",
  branch: "master",
};

test("a merge whose wiki conflicts publishes after the resolver in the same sweep", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: { ...SECURED, pr: 42 },
    ops: {
      merge: { ok: true, merged: true, published: false },
      publish: [CONFLICT, { ok: true, published: true, sha: "c0ffee" }],
      "finish-wiki-sync": { ok: true, resolved: true, headSha: "beef" },
    },
    agents: {
      "i7-conflicts-1": replyWith({ status: "fixed", summary: "Merged." }),
    },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-writer"]);
  const { abort } = requestFor(trace, "finish-wiki-sync");
  assert.equal(abort, false);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "done",
      outcome: "merged",
    }),
  );
});

test("an issue saved at publish publishes and is done", async () => {
  const { trace, summary } = await finishRun({
    stage: "publish",
    fields: { ...SECURED, pr: 42 },
    ops: { publish: { ok: true, published: true, sha: null } },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const { number } = requestFor(trace, "publish");
  assert.equal(number, ISSUE);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "done",
      outcome: "merged",
    }),
  );
});
