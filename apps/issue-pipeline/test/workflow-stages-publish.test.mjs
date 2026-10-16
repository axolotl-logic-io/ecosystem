// @ts-check
// The publish stage through the sweep (#216): a merge whose wiki changes hit a
// conflict moves to publish in the same sweep, where the conflict resolver
// settles the wiki's rebase and the issue's wiki commits are published.
import assert from "node:assert/strict";
import { test } from "node:test";
import { finishRun, SECURED } from "./workflow-finish-run-kit.mjs";
import { launchKeys, replyWith } from "./workflow-stages-fixtures.mjs";

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
  const { trace } = await finishRun({
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
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-wiki-sync-3",
    "i7-wiki-check-4",
    "i7-merge-5",
    "i7-publish-6",
    "i7-conflicts-1-7",
    "i7-finish-wiki-sync-8",
    "i7-publish-9",
    "cleanup-10",
  ]);
});

test("an issue saved at publish publishes and is done", async () => {
  const { trace } = await finishRun({
    stage: "publish",
    fields: { ...SECURED, pr: 42 },
    ops: { publish: { ok: true, published: true, sha: null } },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-publish-3",
    "cleanup-4",
  ]);
});
