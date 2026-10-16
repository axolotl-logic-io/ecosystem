// The save-spec op: writes an issue's full spec to spec.md in its run dir and
// replies with the file's path. The spec stage runs it when the spec is longer
// than the copy the state keeps, so the prompts can name the whole text (#280).

import { z } from "zod";
import type { Config } from "../config.ts";
import { writeSpecFile } from "../issue-context.ts";
import { parseRequest } from "../process.ts";

const SAVE_SPEC_REQUEST = z.looseObject({
  number: z.number().int(),
  spec: z.string(),
});

function saveSpec(cfg: Config, request: unknown): { specFile: string } {
  const { number, spec } = parseRequest(
    SAVE_SPEC_REQUEST,
    "save-spec",
    request,
  );
  return { specFile: writeSpecFile(cfg, number, spec) };
}

export { saveSpec };
