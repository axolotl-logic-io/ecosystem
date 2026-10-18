// @ts-check
// The finalizer's rebase and retest (#422) on a branch whose commits move
// the wiki pin and put it back, with the wiki checkout ahead of the pin, as
// #459's branch had them (#458). Replaying those commits writes the
// gitlink's index entry anew, which drops its assume-unchanged mark; verify's
// clean check still passes, and the merged head keeps the base's pin.
// Against local git and the fake gh, as finalizer-rebase-test-kit.mjs runs a
// merge job.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  branchHead,
  fx,
  mergedAt,
  opsSent,
  placeOf,
  runJob,
} from "./finalizer-rebase-test-kit.mjs";
import {
  addWiki,
  movePinAndBack,
  pinAt,
  wikiAhead,
} from "./wiki-pin-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { ensureWiki } = await import("../src/wiki.ts");

addWiki(fx);
const origin = path.join(fx.root, "origin.git");
const DONE = { kind: "saved", stage: "done" };

test("a merge job whose rebase replays commits that move the wiki pin retests and merges, and the merged head keeps the base's pin", async () => {
  const place = placeOf({ issue: 71, base: "behind", config: { wiki: true } });
  const n = place.issue;
  ensureWiki(loadConfig(place.config), n);
  const wt = fx.worktree(n);
  wikiAhead(wt, `W${n}`);
  movePinAndBack(wt);
  const verified = fx.pushFrom(n);
  place.verified = verified;
  place.saved = { ...place.saved, headSha: verified, verifiedSha: verified };
  const end = await runJob(place);
  assert.deepEqual(end, DONE, JSON.stringify(place.saved.log));
  assert.deepEqual(opsSent(place), [
    "merge",
    "sync-base",
    "verify",
    "ci-status",
    "merge",
  ]);
  const rebased = branchHead(place);
  assert.deepEqual(mergedAt(place), [rebased]);
  assert.equal(pinAt(origin, rebased), pinAt(origin, "integration"));
});
