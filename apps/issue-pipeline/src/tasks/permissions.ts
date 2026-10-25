// The trusted repository configuration's task grants. Only a literal
// `permissions.land: true` in the configuration the process loaded grants
// Land; a missing, malformed or any other value is no grant. A request's
// payload never reaches this: callers pass the loaded configuration.

import { z } from "zod";
import type { Config } from "../config.ts";

const LAND_GRANT = z.looseObject({
  permissions: z.looseObject({ land: z.literal(true) }),
});

function landGranted(cfg: Config): boolean {
  return LAND_GRANT.safeParse(cfg).success;
}

export { landGranted };
