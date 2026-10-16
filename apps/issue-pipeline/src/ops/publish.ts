// The wiki's side of a merge: wiki-sync rebases the issue's wiki commits onto
// the wiki's latest version before the code merges, finish-wiki-sync keeps a
// rebase a writer resolved, and publish pushes the commits to the wiki once
// the code has merged and then finishes the merged issue.

import { z } from "zod";
import { removeWorktree } from "../checkouts.ts";
import { closeClaims } from "../claims.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { gh, issueState } from "../github.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { parseRequest } from "../process.ts";
import type { State } from "../state.ts";
import { STATE, writeState } from "../state.ts";
import type {
  WikiFinishReply,
  WikiPublish,
  WikiSyncReply,
} from "../wiki-publish.ts";
import { finishWikiSync, publishWiki, syncWiki } from "../wiki-publish.ts";

const SHORT_SHA_LENGTH = 12;

const SYNC_REQUEST = z.looseObject({ number: z.number().int() });
const FINISH_REQUEST = z.looseObject({
  number: z.number().int(),
  abort: z.boolean().nullish(),
  reason: z.string().nullish(),
});
const PUBLISH_REQUEST = z.looseObject({
  number: z.number().int(),
  state: STATE.extend({ pr: z.number() }),
});

// GitHub closes an issue from "Closes #N" only when the PR merges into the
// default branch. A base like integration leaves it open, so close it here.
function closeIssue(cfg: Config, n: number, pr: number): void {
  if (issueState(cfg, n) !== "open") {
    return;
  }
  gh(
    cfg,
    [
      "issue",
      "close",
      String(n),
      "-R",
      cfg.repo,
      "--reason",
      "completed",
      "--comment",
      `PR #${pr} merged into ${cfg.baseBranch}.`,
    ],
    { allowFail: true },
  );
}

// The issue is done: its state, labels, claims and worktree say so.
function closeMerged(cfg: Config, n: number, pr: number, state: State): void {
  writeState(cfg, n, { ...state, stage: "done", lease: null });
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.working.name]);
  clearStopLabels(cfg, n);
  closeClaims(cfg, n, `PR #${pr} merged.`);
  closeIssue(cfg, n, pr);
  removeWorktree(cfg, n);
}

// After PR #pr merged: publish the issue's wiki commits and, once they are on
// the wiki (or there are none), finish the issue. A conflict leaves the rebase
// stopped and the issue as it was; a push that keeps failing throws.
function publishMerged(
  cfg: Config,
  n: number,
  pr: number,
  state: State,
): WikiPublish {
  const published = publishWiki(cfg, n);
  if (!published.published) {
    return published;
  }
  if (published.sha !== null) {
    const sha = published.sha.slice(0, SHORT_SHA_LENGTH);
    comment(
      cfg,
      n,
      { role: "merger" },
      `Pushed this issue's wiki changes as wiki commit ${sha} (history: https://github.com/${cfg.repo}/wiki/_history).`,
    );
  }
  closeMerged(cfg, n, pr, state);
  return published;
}

function wikiSyncOp(cfg: Config, request: unknown): WikiSyncReply {
  const req = parseRequest(SYNC_REQUEST, "wiki-sync", request);
  return syncWiki(cfg, req.number);
}

function finishWikiSyncOp(cfg: Config, request: unknown): WikiFinishReply {
  const req = parseRequest(FINISH_REQUEST, "finish-wiki-sync", request);
  let abort: string | null = null;
  if (req.abort === true) {
    abort = "aborted";
  }
  if (abort !== null && typeof req.reason === "string" && req.reason !== "") {
    abort = req.reason;
  }
  return finishWikiSync(cfg, req.number, abort);
}

function publishOp(cfg: Config, request: unknown): WikiPublish {
  const req = parseRequest(PUBLISH_REQUEST, "publish", request);
  return publishMerged(cfg, req.number, req.state.pr, req.state);
}

const publishOps: Readonly<
  Record<
    string,
    (
      cfg: Config,
      request: unknown,
    ) => WikiPublish | WikiSyncReply | WikiFinishReply
  >
> = {
  "wiki-sync": wikiSyncOp,
  "finish-wiki-sync": finishWikiSyncOp,
  publish: publishOp,
};

export { publishMerged, publishOps };
