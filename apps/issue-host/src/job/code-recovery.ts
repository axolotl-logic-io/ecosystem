// Compatibility host grants recovery a destination and command-scoped remote access.
import {
  saveCodeRecovery as saveCode,
  saveMergeRecovery as saveMerge,
} from "@ecosystem/task-runtime/job/code-recovery";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { git } from "../github.ts";

function saveCodeRecovery(
  cfg: Config,
  issue: number,
  repo: string,
  key: string,
): void {
  saveCode(paths.runDir(cfg, issue), repo, key, (): void => {
    git(cfg, "dev", ["-C", repo, "fetch", "--quiet", "--prune", "origin"]);
  });
}
function saveMergeRecovery(
  cfg: Config,
  issue: number,
  repo: string,
  reason: string,
): void {
  saveMerge(paths.runDir(cfg, issue), repo, reason);
}

export { saveCodeRecovery, saveMergeRecovery };
