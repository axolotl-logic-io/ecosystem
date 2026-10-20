// @ts-check
// Multi-pick code histories where a session reaches a later wiki stop itself.
import { spawnSync } from "node:child_process";
import { gitlinkSyncFixture } from "./gitlink-sync-test-kit.mjs";

const { fx, seed, branch, wikiCommit, stagePin, ask, unmerged, resolveText } =
  await gitlinkSyncFixture("session-continuation");
const { sh } = fx;
/** @param {number} n @param {boolean} [mixed] */
function sessionStop(n, mixed = false) {
  if (mixed) {
    // A modify/modify text conflict has all three numbered stages.
    fx.advanceBase(`later${n}`, "common ancestor");
  }
  const wt = branch(n);
  fx.commitIn(n, `early${n}`, "mine");
  stagePin(wt, wikiCommit(`own${n}`));
  fx.commitIn(n, `later${n}`, "mine");
  stagePin(wt, wikiCommit(`last${n}`));
  fx.commitIn(n, `last${n}`, "mine");
  const original = fx.pushFrom(n);
  const target = wikiCommit(`target${n}`);
  stagePin(seed, target);
  if (mixed) {
    fx.advanceBase(`later${n}`, "target");
  }
  const base = fx.advanceBase(`early${n}`, "target");
  const first = ask(n, "sync-base");
  resolveText(wt, `early${n}`);
  const continued = spawnSync(
    "git",
    ["-C", wt, "-c", "core.editor=true", "rebase", "--continue"],
    { encoding: "utf8", timeout: 30_000 },
  );
  const stop = [
    first.conflicts,
    continued.status,
    fx.inRebase(n),
    unmerged(wt).includes("\twiki"),
  ];
  return { n, wt, original, target, base, stop };
}

export {
  ask,
  fx,
  resolveText,
  seed,
  sessionStop,
  sh,
  stagePin,
  unmerged,
  wikiCommit,
};
