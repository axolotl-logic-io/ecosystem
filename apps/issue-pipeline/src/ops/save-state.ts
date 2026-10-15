// The save-state op: writes an issue's state and nothing else. The comments
// the workflow queued ride along on every op (see main in ops.mjs).

import { z } from "zod";
import type { Config } from "../config.ts";
import { writeState } from "../state.ts";

const SAVE_REQUEST = z.looseObject({
  number: z.number(),
  state: z.unknown().optional(),
});

function saveState(cfg: Config, request: unknown): Record<string, never> {
  const { number, state } = SAVE_REQUEST.parse(request);
  if (state !== undefined && state !== null) {
    writeState(cfg, number, state);
  }
  return {};
}

export { saveState };
