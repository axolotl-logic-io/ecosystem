// @ts-check
// Multi-pick code histories where a session reaches a later wiki stop itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
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
    { encoding: "utf8" },
  );
  const stop = [
    first.conflicts,
    continued.status,
    fx.inRebase(n),
    unmerged(wt).includes("\twiki"),
  ];
  return { n, wt, original, target, base, stop };
}

const STAGES = z.array(
  z.object({
    file: z.string(),
    mode: z.string(),
    sha: z.string(),
    stage: z.string(),
  }),
);

/** @param {number} n */
function recoveryEvidence(n) {
  const recovery = path.join(fx.root, "runs", "o__r", `issue-${n}`, "recovery");
  const dir = path.join(recovery, fs.readdirSync(recovery)[0] ?? "missing");
  const bundle = path.join(dir, "commits.bundle");
  const restored = path.join(fx.root, `restored${n}`);
  sh(`git clone -q ${bundle} ${restored}`);
  const stages = STAGES.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "conflict-stages.json"), "utf8")),
  );
  return { stages, bundle, restored };
}

export {
  ask,
  fx,
  recoveryEvidence,
  resolveText,
  seed,
  sessionStop,
  sh,
  stagePin,
  unmerged,
  wikiCommit,
};
