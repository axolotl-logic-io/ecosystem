// The current-revision op: the issue's current revision as revision.ts
// reads it afresh, for the request's state's PR, or the saved state's.

import { z } from "zod";
import type { Config } from "../config.ts";
import { parseRequest } from "../process.ts";
import type { CurrentRevision } from "../revision.ts";
import { currentRevision } from "../revision.ts";
import { ISSUE_STATE, readState } from "../state.ts";

const CURRENT_REVISION_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  state: ISSUE_STATE.nullish(),
});

function currentRevisionOp(cfg: Config, request: unknown): CurrentRevision {
  const req = parseRequest(
    CURRENT_REVISION_REQUEST,
    "current-revision",
    request,
  );
  const state = req.state ?? readState(cfg, req.number).state;
  return currentRevision(cfg, req.number, state);
}

export { currentRevisionOp };
