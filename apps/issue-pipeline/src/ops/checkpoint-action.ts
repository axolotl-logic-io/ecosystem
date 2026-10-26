// `checkpoint-action`: the runtime's durable, evidence-only progress record
// for its action on a work item, in the item's version 4 saved state.
// Request `{number, detail}` (detail: a JSON object); reply
// `{checkpointed: true, action}`, the action's execution instance. It
// writes the action's checkpoint and one log line, and nothing else: no
// stage, approval, clearance or claim. Saved state of another version is
// never adopted, so it refuses, and the caller keeps its local work.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import {
  newWorkState,
  readWorkState,
  withWorkLog,
  writeWorkState,
} from "../saved-state-work.ts";

const REQUEST = z.looseObject({
  number: z.number().int().positive(),
  detail: z.record(z.string(), z.json()),
});

function checkpointAction(
  cfg: Config,
  request: unknown,
): { checkpointed: true; action: string } {
  const req = parseRequest(REQUEST, "checkpoint-action", request);
  if (cfg.execution === undefined) {
    throw new OpsError("a checkpoint is its action's; it needs an execution");
  }
  const stored = readWorkState(cfg, req.number);
  let state = newWorkState(req.number);
  if (stored.kind === "current") {
    ({ state } = stored);
  }
  const action = cfg.execution.instance;
  writeWorkState(
    cfg,
    withWorkLog(
      {
        ...state,
        action,
        branch: paths.branch(cfg, req.number),
        checkpoint: req.detail,
      },
      `action ${action} checkpointed`,
      new Date(),
    ),
  );
  return { checkpointed: true, action };
}

export { checkpointAction };
