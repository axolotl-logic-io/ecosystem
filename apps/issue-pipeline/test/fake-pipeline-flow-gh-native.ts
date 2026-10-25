// Receive-pack's real target reflog is separate from historical REST updates.
import fs from "node:fs";
import path from "node:path";
import { closeMergedPr } from "./fake-pipeline-flow-gh-merge.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import { branchHead, gitSucceeds } from "./fake-pipeline-flow-gh-world.ts";

interface TargetUpdate {
  origin: string;
  ref: string;
  old: string;
  head: string;
}
const PUSH_RECORD =
  /^(?<old>[0-9a-f]{40}) (?<head>[0-9a-f]{40}) [^\n]*\tpush$/u;

function targetPushes(origin: string, target: string): TargetUpdate[] {
  const ref = `refs/heads/${target}`;
  const log = path.join(origin, "logs", ref);
  if (!fs.existsSync(log)) {
    return [];
  }
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .flatMap((line) => {
      const { old, head } = PUSH_RECORD.exec(line)?.groups ?? {};
      if (old === undefined || head === undefined) {
        return [];
      }
      return [{ origin, ref, old, head }];
    });
}

function nativeTargetUpdates(world: World): TargetUpdate[] {
  return targetPushes(world.origin, world.baseBranch).slice(
    world.nativePushStart,
  );
}

// Only an unambiguous open local PR at the exact received H can be projected.
// Reachability alone, a CLOSED PR or another target cannot imply a merge.
function observeNativeMerges(world: World): void {
  const updates = nativeTargetUpdates(world);
  for (const update of updates.slice(world.nativePushesSeen)) {
    const candidates = world.prs.filter(
      (pr) =>
        pr.state === "OPEN" &&
        !pr.isDraft &&
        pr.isCrossRepository !== true &&
        pr.base === world.baseBranch &&
        branchHead(world.origin, pr.head) === update.head,
    );
    if (
      candidates.length === 1 &&
      update.old !== update.head &&
      branchHead(world.origin, world.baseBranch) === update.head &&
      gitSucceeds(world.origin, [
        "merge-base",
        "--is-ancestor",
        update.old,
        update.head,
      ])
    ) {
      const [change] = candidates;
      if (change !== undefined) {
        closeMergedPr(world, change, update.head, update.head);
      }
    }
  }
  world.nativePushesSeen = updates.length;
}

export { nativeTargetUpdates, observeNativeMerges, targetPushes };
