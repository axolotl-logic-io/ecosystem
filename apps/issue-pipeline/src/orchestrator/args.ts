// The orchestrator's arguments: the repo config, the wiki clone its jobs pin
// their prompts from, and whether to run one tick.
// An unknown flag or a missing --config throws, naming the problem.

import { parseArgs } from "node:util";
import { z } from "zod";

const NO_CONFIG = "--config must name a repo config file";
const NO_BRAIN = "--brain-path must name a clone of the repo's wiki";
const ORCHESTRATOR_ARGS = z.object({
  config: z.string({ error: NO_CONFIG }).min(1, NO_CONFIG),
  brainPath: z.string({ error: NO_BRAIN }).min(1, NO_BRAIN),
  once: z.boolean().optional(),
});

type OrchestratorArgs = z.infer<typeof ORCHESTRATOR_ARGS>;

function orchestratorArgsOf(argv: readonly string[]): OrchestratorArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      "brain-path": { type: "string" },
      once: { type: "boolean" },
    },
    strict: true,
  });
  const { "brain-path": brainPath, ...named } = values;
  const parsed = ORCHESTRATOR_ARGS.safeParse({ ...named, brainPath });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { OrchestratorArgs };
export { orchestratorArgsOf };
