// Before either clean or resolved rebase push, preserve the exact intent and both histories.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { rebaseInProgress } from "../rebase.ts";
import { mergeAuthorization } from "../state.ts";
import {
  assertRemote,
  configuredWikiRemote,
  exactRemoteTip,
  freshAuthority,
  validatePreparation,
} from "./authority.ts";
import {
  assertNoUncertainWikiPush,
  COMMAND_MS,
  durableJson,
  keepTip,
  localGit,
  newRecordDir,
  preserveHistory,
  readPreparation,
  recordDir,
  recordIds,
} from "./records.ts";
import type { Preparation } from "./schema.ts";
import { OID, PREPARATION } from "./schema.ts";

interface SyncIdentity {
  lane: string;
  job: string;
}
function prepareWikiSync(
  cfg: Config,
  issue: number,
  dir: string,
  identity: SyncIdentity,
): Preparation {
  const wiki = wikiCfg(cfg);
  if (wiki === null || identity.lane === "" || identity.job === "") {
    throw new OpsError("wiki sync requires an originating job and stable lane");
  }
  // Never resend an uncertain push through a new sync invocation.
  assertNoUncertainWikiPush(cfg, issue);
  const authority = freshAuthority(cfg, issue, identity.lane);
  if (
    rebaseInProgress(dir) ||
    localGit(dir, ["status", "--porcelain"]) !== ""
  ) {
    throw new OpsError("wiki sync requires a clean checkout");
  }
  const old = OID.parse(localGit(dir, ["rev-parse", "HEAD"]));
  if (mergeAuthorization(authority)?.wiki !== old) {
    throw new OpsError(
      "wiki sync source is not the original saved authorization; refusing push",
    );
  }
  const target = OID.parse(
    localGit(dir, ["rev-parse", `refs/remotes/origin/${wiki.branch}`]),
  );
  const expected = exactRemoteTip(cfg, dir, paths.branch(cfg, issue));
  if (expected !== null && expected !== old) {
    throw new OpsError(
      "wiki issue branch moved before sync; explicit reconciliation required",
    );
  }
  const { id, dir: folder } = newRecordDir(cfg, issue);
  const prep = PREPARATION.parse({
    version: 1,
    id,
    repo: cfg.repo,
    remote: configuredWikiRemote(cfg),
    base: cfg.baseBranch,
    wikiBranch: wiki.branch,
    issue,
    branch: paths.branch(cfg, issue),
    ...identity,
    checkout: fs.realpathSync(dir),
    old,
    target,
    expected,
    authority,
    at: new Date().toISOString(),
  });
  const refs = [
    keepTip(dir, prep, "old", old),
    keepTip(dir, prep, "target", target),
  ];
  preserveHistory(folder, dir, "before", refs);
  durableJson(path.join(folder, "preparation.json"), prep);
  return prep;
}
function pendingWikiSync(
  cfg: Config,
  issue: number,
  dir: string,
  identity: SyncIdentity,
): Preparation {
  const pending = recordIds(cfg, issue)
    .map((id) => readPreparation(cfg, issue, id))
    .filter(
      (prep) =>
        prep.job === identity.job &&
        prep.lane === identity.lane &&
        prep.checkout === fs.realpathSync(dir) &&
        !fs.existsSync(
          path.join(recordDir(cfg, issue, prep.id), "intent.json"),
        ) &&
        !fs.existsSync(
          path.join(recordDir(cfg, issue, prep.id), "abandoned.json"),
        ),
    );
  const [prepared] = pending;
  if (pending.length !== 1 || prepared === undefined) {
    throw new OpsError(
      "no unique original wiki rebase preparation; explicit reconciliation required",
    );
  }
  return prepared;
}
function abandonWikiSync(cfg: Config, prep: Preparation): void {
  durableJson(
    path.join(recordDir(cfg, prep.issue, prep.id), "abandoned.json"),
    { id: prep.id },
  );
}
function pushSyncedWiki(
  cfg: Config,
  issue: number,
  dir: string,
  prep: Preparation,
): void {
  validatePreparation(cfg, issue, prep, { lane: prep.lane });
  assertRemote(cfg, dir);
  const next = OID.parse(localGit(dir, ["rev-parse", "HEAD"]));
  if (
    rebaseInProgress(dir) ||
    localGit(dir, ["status", "--porcelain"]) !== "" ||
    localGit(dir, ["rev-parse", `refs/remotes/origin/${prep.wikiBranch}`]) !==
      prep.target
  ) {
    throw new OpsError(
      "wiki rebase target or checkout changed; refusing recovery intent and push",
    );
  }
  const folder = recordDir(cfg, issue, prep.id);
  preserveHistory(folder, dir, "after", [keepTip(dir, prep, "new", next)]);
  durableJson(path.join(folder, "intent.json"), { id: prep.id, new: next });
  const ref = `refs/heads/${prep.branch}`;
  git(
    cfg,
    "dev",
    [
      "-C",
      dir,
      "push",
      `--force-with-lease=${ref}:${prep.expected ?? ""}`,
      "origin",
      `${next}:${ref}`,
    ],
    { timeoutMs: COMMAND_MS },
  );
  durableJson(path.join(folder, "completion.json"), {
    id: prep.id,
    new: next,
    response: "acknowledged",
  });
}

export type { SyncIdentity };
export { abandonWikiSync, pendingWikiSync, prepareWikiSync, pushSyncedWiki };
