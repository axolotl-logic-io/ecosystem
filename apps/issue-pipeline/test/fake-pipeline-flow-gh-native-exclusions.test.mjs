// @ts-check
// Negative real-Git controls for the fake service's native observation.
import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  branchHead,
  gitIn,
  gitSucceeds,
  issueOf,
} from "./fake-pipeline-flow-gh-world.mjs";
import { git } from "./job-git-test-kit.mjs";

/** @param {ReturnType<typeof nativeWorld>} fixture @param {string} defect */
function excludePr({ world, old, head }, defect) {
  const [change] = world.prs;
  if (change === undefined) {
    throw new Error("missing fixture PR");
  }
  switch (defect) {
    case "CLOSED unmerged":
      change.state = "CLOSED";
      change.closedHead = head;
      return { state: change.state };
    case "wrong target":
      change.base = "main";
      return { target: change.base };
    case "foreign head":
      change.head = "another-source";
      gitIn(world.origin, ["update-ref", `refs/heads/${change.head}`, old]);
      return { head: branchHead(world.origin, change.head) };
    case "foreign repository":
      change.isCrossRepository = true;
      return { foreign: change.isCrossRepository };
    case "ambiguous":
      world.prs.push({ ...change, number: change.number + 1 });
      return {
        matches: world.prs.filter(
          (pr) =>
            pr.base === BASE && branchHead(world.origin, pr.head) === head,
        ).length,
      };
    case "draft":
      change.isDraft = true;
      return { draft: change.isDraft };
    default:
      throw new Error(`unknown defect ${defect}`);
  }
}

for (const defect of [
  "CLOSED unmerged",
  "wrong target",
  "foreign head",
  "foreign repository",
  "ambiguous",
  "draft",
]) {
  test(`native observation leaves ${defect} PR evidence unmerged`, () => {
    const fixture = nativeWorld();
    const { world, old, head } = fixture;
    /** @type {Map<string, object>} */
    const expected = new Map([
      ["CLOSED unmerged", { state: "CLOSED" }],
      ["wrong target", { target: "main" }],
      ["foreign head", { head: old }],
      ["foreign repository", { foreign: true }],
      ["ambiguous", { matches: 2 }],
      ["draft", { draft: true }],
    ]);
    assert.notEqual(old, head);
    assert.deepEqual(excludePr(fixture, defect), expected.get(defect));
    const snapshot = structuredClone(world.prs);
    assert.equal(branchHead(world.origin, BASE), old);
    assert.equal(world.prs[0]?.mergeOid, null);
    pushTarget(fixture);
    assert.equal(branchHead(world.origin, BASE), head);
    observeNativeMerges(world);
    assert.deepEqual(world.prs, snapshot);
    assert.equal(issueOf(world, ISSUE).state, "open");
    assert.equal(nativeTargetUpdates(world).length, 1);
  });
}

test("reachable source and equal heads without a native push cannot fabricate a merged PR", () => {
  const { world, old, head } = nativeWorld();
  assert.notEqual(old, head);
  gitIn(world.origin, [
    "update-ref",
    "-m",
    "external-ref-edit",
    `refs/heads/${BASE}`,
    head,
    old,
  ]);
  assert.equal(branchHead(world.origin, BASE), head);
  assert.deepEqual(nativeTargetUpdates(world), []);
  observeNativeMerges(world);
  assert.equal(world.prs[0]?.state, "OPEN");
  assert.equal(issueOf(world, ISSUE).state, "open");
});

test("a native target descendant of H does not project a merely reachable PR as merged", () => {
  const fixture = nativeWorld();
  const { world, old, head } = fixture;
  const descendant = git([
    "-C",
    fixture.seed,
    "commit-tree",
    `${head}^{tree}`,
    "-p",
    head,
    "-m",
    "later target",
  ]);
  assert.notEqual(descendant, head);
  assert.equal(
    gitSucceeds(world.origin, ["merge-base", "--is-ancestor", old, head]),
    true,
  );
  pushTarget(fixture, descendant);
  assert.equal(
    gitSucceeds(world.origin, [
      "merge-base",
      "--is-ancestor",
      head,
      descendant,
    ]),
    true,
  );
  observeNativeMerges(world);
  assert.equal(world.prs[0]?.state, "OPEN");
  assert.equal(world.prs[0]?.mergeOid, null);
});

test("an exact native target with a non-ancestor old target cannot fabricate an FF merge", () => {
  const fixture = nativeWorld();
  const { world, old, head } = fixture;
  const unrelated = git([
    "-C",
    fixture.seed,
    "commit-tree",
    `${head}^{tree}`,
    "-m",
    "unrelated source",
  ]);
  git([
    "-C",
    fixture.seed,
    "push",
    "--quiet",
    `--force-with-lease=refs/heads/${SOURCE}:${head}`,
    world.origin,
    `${unrelated}:refs/heads/${SOURCE}`,
  ]);
  assert.equal(branchHead(world.origin, SOURCE), unrelated);
  assert.equal(
    gitSucceeds(world.origin, ["merge-base", "--is-ancestor", old, unrelated]),
    false,
  );
  pushTarget(fixture, unrelated);
  assert.equal(branchHead(world.origin, BASE), unrelated);
  observeNativeMerges(world);
  assert.equal(world.prs[0]?.state, "OPEN");
  assert.equal(world.prs[0]?.mergeOid, null);
  assert.equal(issueOf(world, ISSUE).state, "open");
});
