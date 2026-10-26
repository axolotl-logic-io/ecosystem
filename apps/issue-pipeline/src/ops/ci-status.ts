// A pull request check as `gh pr checks --json` reports it, and whether
// it failed.

import { z } from "zod";

const CHECKS = z.array(
  z.looseObject({
    bucket: z.unknown(),
    link: z.string().nullish(),
    name: z.string(),
  }),
);
type Check = z.infer<typeof CHECKS>[number];

function isFailing(check: Check): boolean {
  return check.bucket === "fail" || check.bucket === "cancel";
}

export type { Check };
export { CHECKS, isFailing };
