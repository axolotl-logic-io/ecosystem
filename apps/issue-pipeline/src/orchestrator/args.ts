// The orchestrator's arguments: the repo config, and whether to run one tick.
// An unknown flag or a missing --config throws, naming the problem.

import { parseArgs } from "node:util";
import { z } from "zod";

const NO_CONFIG = "--config must name a repo config file";
const ORCHESTRATOR_ARGS = z.object({
  config: z.string({ error: NO_CONFIG }).min(1, NO_CONFIG),
  once: z.boolean().optional(),
});

type OrchestratorArgs = z.infer<typeof ORCHESTRATOR_ARGS>;

function orchestratorArgsOf(argv: readonly string[]): OrchestratorArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      once: { type: "boolean" },
    },
    strict: true,
  });
  const parsed = ORCHESTRATOR_ARGS.safeParse(values);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { OrchestratorArgs };
export { orchestratorArgsOf };
