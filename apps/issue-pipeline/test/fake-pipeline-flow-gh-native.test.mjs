// @ts-check
// The fake service must observe receive-pack, not invent merges from ancestry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchMerge } from "./fake-pipeline-flow-gh-merge.mjs";
import {
  nativeTargetUpdates,
  observeNativeMerges,
} from "./fake-pipeline-flow-gh-native.mjs";
import {
  BASE,
  ISSUE,
  nativeWorld,
  pushTarget,
  SOURCE,
} from "./fake-pipeline-flow-gh-native-test-kit.mjs";
import { viewOf } from "./fake-pipeline-flow-gh-pr.mjs";
import { pr } from "./fake-pipeline-flow-gh-prs.mjs";
import {
  branchHead,
  gitIn,
  gitSucceeds,
  issueOf,
} from "./fake-pipeline-flow-gh-world.mjs";

const COMMIT_AND_TWO_PARENTS = 3;

test("native FF projects exact MERGED metadata, retains H after deletion and closes the default-branch issue", () => {
  const fixture = nativeWorld();
  const { world, old, head } = fixture;
  const [change] = world.prs;
  assert.ok(change !== undefined);
  assert.equal(change.state, "OPEN");
  assert.equal(branchHead(world.origin, BASE), old);
  assert.notEqual(old, head);
  assert.equal(
    gitSucceeds(world.origin, ["merge-base", "--is-ancestor", old, head]),
    true,
  );
  assert.deepEqual(nativeTargetUpdates(world), []);
  pushTarget(fixture);
  observeNativeMerges(world);
  assert.deepEqual(nativeTargetUpdates(world), [
    { origin: world.origin, ref: `refs/heads/${BASE}`, old, head },
  ]);
  assert.equal(branchHead(world.origin, BASE), head);
  assert.equal(
    gitIn(world.origin, ["show", `${head}:code.txt`]),
    "whole contribution",
  );
  assert.equal(
    gitIn(world.origin, ["show", `${head}:docs/change.md`]),
    "docs contribution",
  );
  assert.equal(
    gitIn(world.origin, ["ls-tree", head, "module"]),
    `160000 commit ${old}\tmodule`,
  );
  assert.equal(
    Number(gitIn(world.origin, ["rev-list", "--count", `${old}..${head}`])),
    2,
  );
  assert.equal(change.state, "MERGED");
  assert.equal(change.mergeOid, head);
  assert.equal(change.mergedHead, head);
  assert.equal(issueOf(world, change.number).state, "closed");
  assert.equal(issueOf(world, ISSUE).state, "closed");
  assert.equal(issueOf(world, ISSUE).stateReason, "completed");
  gitIn(world.origin, ["update-ref", "-d", `refs/heads/${SOURCE}`]);
  const { headRefOid } = viewOf(world, change);
  assert.equal(headRefOid, head);
  observeNativeMerges(world);
  assert.equal(nativeTargetUpdates(world).length, 1);
});

test("native FF into a nondefault configured target closes its PR but not the linked issue", () => {
  const fixture = nativeWorld();
  const { world, old } = fixture;
  gitIn(world.origin, ["update-ref", "refs/heads/main", old]);
  gitIn(world.origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  assert.equal(
    gitIn(world.origin, ["symbolic-ref", "HEAD"]),
    "refs/heads/main",
  );
  pushTarget(fixture);
  observeNativeMerges(world);
  const [change] = world.prs;
  assert.ok(change !== undefined);
  assert.equal(change.state, "MERGED");
  assert.equal(issueOf(world, change.number).state, "closed");
  assert.equal(issueOf(world, ISSUE).state, "open");
});

test("historical REST creates genuine ordered two-parent objects and is never counted as native", () => {
  const { world, old, head } = nativeWorld();
  assert.equal(branchHead(world.origin, BASE), old);
  assert.deepEqual(nativeTargetUpdates(world), []);
  const response = branchMerge(world, [
    `repos/${world.repo}/merges`,
    "--method",
    "POST",
    "--include",
    "-f",
    `base=${BASE}`,
    "-f",
    `head=${head}`,
  ]);
  assert.equal(response.code, 0);
  assert.ok(response.stdout?.startsWith("HTTP/2.0 201 Created"));
  const merged = branchHead(world.origin, BASE);
  assert.ok(merged !== null);
  assert.notEqual(merged, head);
  const parents = gitIn(world.origin, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    merged,
  ]).split(" ");
  assert.equal(parents.length, COMMIT_AND_TWO_PARENTS);
  assert.deepEqual(parents, [merged, old, head]);
  observeNativeMerges(world);
  assert.deepEqual(nativeTargetUpdates(world), []);
  assert.equal(world.prs[0]?.mergeOid, merged);
  assert.equal(world.prs[0]?.mergedHead, head);
  assert.equal(issueOf(world, ISSUE).state, "closed");
});

test("withheld CLOSED binding stays incompatible after native landing until explicit caller recovery", () => {
  const fixture = nativeWorld();
  const { world, head } = fixture;
  pushTarget(fixture);
  observeNativeMerges(world);
  const [change] = world.prs;
  assert.ok(change !== undefined);
  assert.equal(change.state, "MERGED");
  world.withholdMergeBinding = true;
  const args = [
    "pr",
    "view",
    String(change.number),
    "--json",
    "state,mergeCommit,headRefOid",
  ];
  assert.deepEqual(JSON.parse(String(pr(world, args).stdout)), {
    state: "CLOSED",
    mergeCommit: null,
    headRefOid: head,
  });
  world.withholdMergeBinding = false;
  assert.deepEqual(JSON.parse(String(pr(world, args).stdout)), {
    state: "MERGED",
    mergeCommit: { oid: head },
    headRefOid: head,
  });
  assert.equal(nativeTargetUpdates(world).length, 1);
});
