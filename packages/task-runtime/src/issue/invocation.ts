// Nonsecret issue-host inputs and a separate credential capability channel.
import path from "node:path";
import { z } from "zod";

const MAX_CLAIM_WAIT_MS = 60_000;
const ABSOLUTE = z
  .string()
  .refine((file) => path.isAbsolute(file), "must be absolute");
const issueInvocation = z.strictObject({
  version: z.literal(1),
  task: z.string().min(1),
  issue: z.strictObject({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
    number: z.int().positive(),
  }),
  settings: z.strictObject({
    config: ABSOLUTE,
    base: z.string().min(1),
    claimWaitsMs: z.array(z.int().min(0).max(MAX_CLAIM_WAIT_MS)).max(10),
  }),
  account: z.string().min(1),
});
const issueCredentials = z.strictObject({
  account: z.string().min(1),
  env: z.array(z.tuple([z.string(), z.string()])),
  hiddenVariables: z.array(z.string()),
});
interface Identity {
  config: string;
  base: string;
  claimWaitsMs: readonly number[];
  account: string;
  env: ReadonlyMap<string, string>;
}
type IssueInvocation = z.infer<typeof issueInvocation>;

export type { Identity, IssueInvocation };
export { issueCredentials, issueInvocation };
