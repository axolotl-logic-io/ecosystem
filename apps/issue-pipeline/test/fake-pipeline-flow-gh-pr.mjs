// @ts-check
// The private service's PR identity and mergeability projection.
import { branchHead, gitSucceeds } from "./fake-pipeline-flow-gh-world.mjs";

/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").FlowPr} FlowPr */

/**
 * GitHub's mergeability of an open PR: clean on the base, behind it, or
 * conflicting with it.
 * @param {World} world @param {FlowPr} change @param {string | null} head
 */
function mergeability(world, change, head) {
  const base = branchHead(world.origin, change.base);
  const clean = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  if (change.state !== "OPEN" || head === null || base === null) {
    return clean;
  }
  if (gitSucceeds(world.origin, ["merge-base", "--is-ancestor", base, head])) {
    return clean;
  }
  const tree = ["merge-tree", "--write-tree", base, head];
  if (gitSucceeds(world.origin, tree)) {
    return { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" };
  }
  return { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
}

/**
 * The PR as `gh pr view --json` shows it.
 * @param {World} world @param {FlowPr} change @returns {Record<string, unknown>}
 */
function viewOf(world, change) {
  const live = branchHead(world.origin, change.head);
  let mergeCommit = null;
  if (change.mergeOid !== null) {
    mergeCommit = { oid: change.mergeOid };
  }
  return {
    number: change.number,
    state: change.state,
    title: change.title,
    body: change.body,
    headRefName: change.head,
    headRefOid: change.mergedHead ?? live ?? change.closedHead ?? "",
    baseRefName: change.base,
    isCrossRepository: false,
    url: `https://github.com/${world.repo}/pull/${change.number}`,
    isDraft: change.isDraft,
    mergeCommit,
    ...mergeability(world, change, live),
  };
}

export { viewOf };
