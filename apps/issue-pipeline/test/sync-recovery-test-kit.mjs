// @ts-check
// Read conflict evidence and restore its history in an independent repository.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sh } from "./ops-run-test-kit.mjs";

const STAGES = z.array(
  z.object({
    file: z.string(),
    mode: z.string(),
    sha: z.string(),
    stage: z.string(),
  }),
);

/** @param {string} root @param {number} n */
function recoveryEvidence(root, n) {
  const recovery = path.join(root, "runs", "o__r", `issue-${n}`, "recovery");
  const dir = path.join(recovery, fs.readdirSync(recovery)[0] ?? "missing");
  const bundle = path.join(dir, "commits.bundle");
  const restored = path.join(root, `restored${n}`);
  sh(`git clone -q ${bundle} ${restored}`);
  const stages = STAGES.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "conflict-stages.json"), "utf8")),
  );
  return { dir, stages, bundle, restored };
}

export { recoveryEvidence };
