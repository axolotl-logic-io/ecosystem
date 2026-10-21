// Checked wiki integration and publication: wiki-sync rebases private work,
// finish-wiki-sync checks a writer's resolution, and pin-wiki records the
// integrated result in unmerged code before verification. publish fast-forwards
// to the authorized wiki head only after the security/publication gates hold.
// Completion and issue close remain separate operations.

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
import { pinIntegratedWiki } from "./push.ts";

const SYNC_REQUEST = z.looseObject({ number: z.number().int() });
const SYNC_IDENTITY = z.looseObject({
  lane: z.string().min(1),
  jobId: z.string().min(1),
});
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

function pinWikiOp(cfg: Config, request: unknown): { changed: boolean } {
  const req = parseRequest(SYNC_REQUEST, "pin-wiki", request);
  return { changed: pinIntegratedWiki(cfg, req.number) };
}

function wikiSyncOp(cfg: Config, request: unknown): WikiSyncReply {
  const req = parseRequest(SYNC_REQUEST, "wiki-sync", request);
  const identity = parseRequest(SYNC_IDENTITY, "wiki-sync identity", request);
  return syncWiki(cfg, req.number, {
    lane: identity.lane,
    job: identity.jobId,
  });
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
  const identity = parseRequest(
    SYNC_IDENTITY,
    "finish-wiki-sync identity",
    request,
  );
  return finishWikiSync(cfg, req.number, abort, {
    lane: identity.lane,
    job: identity.jobId,
  });
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
    ) => PublishReply | WikiSyncReply | WikiFinishReply | { changed: boolean }
  >
> = {
  "pin-wiki": pinWikiOp,
  "wiki-sync": wikiSyncOp,
  "finish-wiki-sync": finishWikiSyncOp,
  publish: publishOp,
};

export type { PublishReply };
export { publishOps };
