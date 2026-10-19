// The non-secret issue identity shared by configured commands and role tools.
// Resource naming belongs to the operator's setup, not the reusable pipeline.
import type { Config } from "./config.ts";
import { paths } from "./config.ts";

function issueEnvironment(
  cfg: Config,
  issue: number,
): ReadonlyMap<string, string> {
  return new Map([
    ["ISSUE_PIPELINE_REPO", cfg.repo],
    ["ISSUE_PIPELINE_ISSUE", String(issue)],
    ["ISSUE_PIPELINE_RUN_DIR", paths.runDir(cfg, issue)],
  ]);
}

export { issueEnvironment };
