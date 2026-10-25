// The private service's PR identity and mergeability projection.

import type { FlowPr, World } from "./fake-pipeline-flow-gh-world.ts";
import { branchHead, gitSucceeds } from "./fake-pipeline-flow-gh-world.ts";

// GitHub's mergeability of an open PR: clean on the base, behind it, or
// conflicting with it.
function mergeability(
  world: World,
  change: FlowPr,
  head: string | null,
): { mergeable: string; mergeStateStatus: string } {
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

// The PR as `gh pr view --json` shows it.
function viewOf(world: World, change: FlowPr): Record<string, unknown> {
  const live = branchHead(world.origin, change.head);
  let mergeCommit: { oid: string } | null = null;
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
    isCrossRepository: change.isCrossRepository ?? false,
    url: `https://github.com/${world.repo}/pull/${change.number}`,
    isDraft: change.isDraft,
    mergeCommit,
    ...mergeability(world, change, live),
  };
}

export { viewOf };
