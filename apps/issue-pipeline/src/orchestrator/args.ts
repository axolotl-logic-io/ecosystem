// The orchestrator's arguments: the repo config, whether to run one tick, the
// roles to run (--roles, split on commas) and whether to print the roles
// instead (--print-roles). An unknown flag, a missing --config or an empty
// role name throws, naming the problem; rolesOf (roles.ts) checks the names.

import { parseArgs } from "node:util";
import { z } from "zod";

const NO_CONFIG = "--config must name a repo config file";
const EMPTY_ROLE = "--roles has an empty role name";
const ORCHESTRATOR_ARGS = z.object({
  config: z.string({ error: NO_CONFIG }).min(1, NO_CONFIG),
  once: z.boolean().optional(),
  roles: z.array(z.string().min(1, EMPTY_ROLE)).optional(),
  printRoles: z.boolean().optional(),
});

type OrchestratorArgs = z.infer<typeof ORCHESTRATOR_ARGS>;

function orchestratorArgsOf(argv: readonly string[]): OrchestratorArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      once: { type: "boolean" },
      roles: { type: "string" },
      "print-roles": { type: "boolean" },
    },
    strict: true,
  });
  const { roles, "print-roles": printRoles, ...rest } = values;
  const parsed = ORCHESTRATOR_ARGS.safeParse({
    ...rest,
    roles: roles?.split(","),
    printRoles,
  });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { OrchestratorArgs };
export { orchestratorArgsOf };
