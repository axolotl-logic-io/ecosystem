// An explicit pre-checkpoint operator decision, never invented historical success.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { git } from "../github.ts";
import { withWikiLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { mergeAuthorization } from "../state.ts";
import { assertRemote, exactRemoteTip, freshAuthority } from "./authority.ts";
import {
  COMMAND_MS,
  durableJson,
  evidenceText,
  keepTip,
  localGit,
  newRecordDir,
  preserveHistory,
  recordDir,
  recordIds,
} from "./records.ts";
import { PREPARATION } from "./schema.ts";
import { privateTip, retainedWork } from "./selection.ts";

interface OperatorSelection {
  number: number;
  lane: string;
  retained: string;
  old: string;
  next: string;
  target: string;
  jobEvidence: string;
  rationale: string;
}
const LEGACY_JOB = z.looseObject({
  id: z.string().min(1),
  issue: z.number().int().positive(),
  stage: z.literal("merge"),
  lane: z.string().min(1),
  launches: z.array(
    z.looseObject({
      key: z.string(),
      kind: z.string(),
      outcome: z.string().nullable(),
    }),
  ),
});
const WIKI_SYNC_LAUNCH = /^wiki-sync-\d+$/u;
// A local job record is corroboration only. Fresh saved authority is mandatory.
function legacyEvidence(
  cfg: Config,
  req: OperatorSelection,
): {
  authority: import("../state.ts").IssueState;
  job: z.infer<typeof LEGACY_JOB>;
  bytes: string;
} {
  const issue = req.number;
  if (recordIds(cfg, issue).length > 0) {
    throw new OpsError(
      "pre-checkpoint selection requires no existing wiki sync evidence; do not erase evidence to proceed",
    );
  }
  const authority = freshAuthority(cfg, issue, req.lane);
  const original = mergeAuthorization(authority);
  const bytes = evidenceText(req.jobEvidence);
  const job = LEGACY_JOB.parse(JSON.parse(bytes));
  if (
    job.issue !== issue ||
    job.lane !== req.lane ||
    wikiCfg(cfg) === null ||
    original?.wiki !== req.old ||
    privateTip(paths.wikiMirror(cfg), paths.branch(cfg, issue)) !== req.old ||
    !job.launches.some(
      (launch) =>
        launch.kind === "ops" &&
        WIKI_SYNC_LAUNCH.test(launch.key) &&
        launch.outcome === "ok",
    )
  ) {
    throw new OpsError(
      "pre-checkpoint job, original authorization or private history is not attributable; incident remains stopped",
    );
  }
  return { authority, job, bytes };
}
function observedLegacyHistory(
  cfg: Config,
  prep: import("./schema.ts").Preparation,
  next: string,
): void {
  const mirror = paths.wikiMirror(cfg);
  git(
    cfg,
    "merge",
    [
      "-C",
      mirror,
      "fetch",
      "--refmap=",
      "origin",
      `refs/heads/${prep.branch}:refs/pipeline/wiki-sync/${prep.id}/observed`,
    ],
    { timeoutMs: COMMAND_MS },
  );
  if (
    localGit(mirror, [
      "rev-parse",
      `refs/pipeline/wiki-sync/${prep.id}/observed`,
    ]) !== next ||
    localGit(mirror, ["merge-base", prep.target, next]) !== prep.target
  ) {
    throw new OpsError(
      "operator read-back changed or target is not in selected history; incident remains stopped",
    );
  }
  const folder = recordDir(cfg, prep.issue, prep.id);
  preserveHistory(folder, mirror, "before", [
    keepTip(mirror, prep, "old", prep.old),
    keepTip(mirror, prep, "target", prep.target),
  ]);
  preserveHistory(folder, mirror, "after", [
    keepTip(mirror, prep, "new", next),
  ]);
}
function legacyPreparation(
  cfg: Config,
  req: OperatorSelection,
  authority: import("../state.ts").IssueState,
  job: string,
): import("./schema.ts").Preparation {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    throw new OpsError("no configured wiki");
  }
  const remote = assertRemote(cfg, paths.wikiMirror(cfg));
  assertRemote(cfg, req.retained);
  if (
    exactRemoteTip(
      cfg,
      paths.wikiMirror(cfg),
      paths.branch(cfg, req.number),
    ) !== req.next
  ) {
    throw new OpsError(
      "operator-selected wiki tip is not the exact configured remote issue tip",
    );
  }
  const { id } = newRecordDir(cfg, req.number);
  return PREPARATION.parse({
    version: 1,
    id,
    repo: cfg.repo,
    remote,
    base: cfg.baseBranch,
    wikiBranch: wiki.branch,
    issue: req.number,
    branch: paths.branch(cfg, req.number),
    lane: req.lane,
    job,
    checkout: fs.realpathSync(req.retained),
    old: req.old,
    target: req.target,
    expected: req.old,
    authority,
    at: new Date().toISOString(),
  });
}
// This records today's operator decision, not a historical intent or push response.
function selectLegacyWiki(
  cfg: Config,
  req: OperatorSelection,
): { selected: true; id: string } {
  return withWikiLock(
    cfg,
    () => {
      const issue = req.number;
      const { authority, job, bytes } = legacyEvidence(cfg, req);
      const prep = legacyPreparation(cfg, req, authority, job.id);
      const { id } = prep;
      const folder = recordDir(cfg, issue, id);
      retainedWork(prep, req.next, req.retained);
      observedLegacyHistory(cfg, prep, req.next);
      durableJson(path.join(folder, "preparation.json"), prep);
      durableJson(path.join(folder, "operator.json"), {
        kind: "pre-checkpoint-decision",
        rationale: req.rationale,
        evidence: bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        warning:
          "No historical intent or acknowledged push response is asserted. This decision grants no verification, merge or publication authority.",
      });
      durableJson(path.join(folder, "selection.json"), {
        id,
        new: req.next,
        private: req.old,
        retained: fs.realpathSync(req.retained),
        basis: req.rationale,
        kind: "operator",
      });
      return { selected: true, id };
    },
    { wait: false },
  );
}

export type { OperatorSelection };
export { selectLegacyWiki };
