// The wiki's side of a merge: wiki-sync rebases the issue's wiki commits onto
// the wiki's latest version before the review that approves them,
// finish-wiki-sync keeps a rebase a writer resolved, and publish fast-forwards
// the wiki to exactly the approved wiki head once the code merged (or, for a
// change that lives only in the wiki, with no PR). Publishing changes nothing
// else: the role saves the completion and finish-wiki closes the issue.

import { z } from "zod";
import type { Config } from "../config.ts";
import { parseRequest } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { readState } from "../saved-state.ts";
import { ISSUE_STATE } from "../state.ts";
import type { WikiPublish } from "../wiki-publication.ts";
import { publishReviewedWiki } from "../wiki-publication.ts";
import type { WikiFinishReply, WikiSyncReply } from "../wiki-publish.ts";
import { finishWikiSync, syncWiki } from "../wiki-publish.ts";
import type { PublishRefusal } from "./publication-guard.ts";
import { publishGate, REVISION_REQUEST } from "./publication-guard.ts";

const SYNC_REQUEST = z.looseObject({ number: z.number().int() });
const FINISH_REQUEST = z.looseObject({
  number: z.number().int(),
  abort: z.boolean().nullish(),
  reason: z.string().nullish(),
});
const PUBLISH_REQUEST = z.looseObject({
  number: z.number().int(),
  state: ISSUE_STATE,
  // The wiki head the review approved, null when it approved no wiki commits.
  expectedWiki: z.string().min(1).nullable(),
  revision: REVISION_REQUEST,
});

type PublishReply = WikiPublish | PublishRefusal;

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

// Publishes the approved wiki head after the fresh gates (publication-guard)
// pass against GitHub and the saved state, or says why not. Safe to repeat: a wiki that already holds the head
// is a success.
function publishOp(cfg: Config, request: unknown): PublishReply {
  const req = parseRequest(PUBLISH_REQUEST, "publish", request);
  const current = currentRevision(cfg, req.number, req.state);
  const { state: saved } = readState(cfg, req.number);
  const refused = publishGate(req.state, saved, req, current);
  if (refused !== undefined) {
    return refused;
  }
  return publishReviewedWiki(cfg, req.number, req.expectedWiki);
}

const publishOps: Readonly<
  Record<
    string,
    (
      cfg: Config,
      request: unknown,
    ) => PublishReply | WikiSyncReply | WikiFinishReply
  >
> = {
  "wiki-sync": wikiSyncOp,
  "finish-wiki-sync": finishWikiSyncOp,
  publish: publishOp,
};

export type { PublishReply };
export { publishOps };
