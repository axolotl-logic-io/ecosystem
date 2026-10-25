// A row of a repo's open-issue listing, as the sweep reads it: its number,
// its assignees, and whether GitHub keeps it for a pull request.

import { z } from "zod";
import { wire } from "../../src/discovery/wire.ts";

const OPEN_ISSUE = wire(
  z.looseObject({
    number: z.number().int().positive(),
    assignees: z.array(z.looseObject({ login: z.string() })),
    pullRequest: z.unknown().optional(),
  }),
);

export { OPEN_ISSUE };
