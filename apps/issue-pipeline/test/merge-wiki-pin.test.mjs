// @ts-check
// Authorization cannot certify a final wiki head absent from the code tree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "./merge-op-test-kit.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  prView,
  savedListing,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

test("merge refuses an approved wiki revision not pinned by its exact code tree, before approval or merge writes", () => {
  const w = world({ wiki: true });
  // This fixture has separate, current wiki history but no code gitlink.
  const approved = { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  fakeGh.reply([
    savedListing(approvedState(approved)),
    prView({ headRefOid: w.sha }),
  ]);
  const reply = merge(
    w.cfg,
    request(w, { revision: approved, state: approvedState(approved) }),
  );
  assert.deepEqual(reply, {
    merged: false,
    reason: "wiki-pin",
    detail: `the authorized code tree must pin the integrated wiki commit ${w.wikiSha} at wiki`,
  });
  assert.deepEqual(writes(), []);
});
