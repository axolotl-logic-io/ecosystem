import { z } from "zod";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import type { Hub } from "./github.ts";

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const REF = z.object({ object: z.object({ sha: SHA }) }).nullable();
const COMMIT = z.object({
  sha: SHA,
  tree: z.object({ sha: SHA }),
  message: z.string(),
});

function issueLock(issue: number): string {
  return `heads/pipeline-execution/issue-${issue}`;
}
function integrationLock(base: string): string {
  return `heads/pipeline-integration/${Buffer.from(base).toString("hex")}`;
}
function lockHead(hub: Hub, ref: string): string | null {
  return REF.parse(hub.read(`git/ref/${ref}`))?.object.sha ?? null;
}

// Ref creation is GitHub's atomic create-if-absent operation. Comments and
// logical lanes alone cannot exclude two processes sharing an identity.
// Locks never expire into a second writer: a stale lock requires explicit
// reconciliation, including uncertain writes and local-only recovery.
function acquire(
  hub: Hub,
  cfg: Config,
  ref: string,
  owner: string,
): string | null {
  if (lockHead(hub, ref) !== null) {
    return null;
  }
  const base = REF.parse(hub.read(`git/ref/heads/${cfg.baseBranch}`));
  if (base === null) {
    throw new OpsError("integration base is missing");
  }
  const parent = COMMIT.parse(hub.read(`git/commits/${base.object.sha}`));
  const commit = COMMIT.parse(
    hub.create("git/commits", {
      message: `pipeline exclusive execution ${owner} ${crypto.randomUUID()}`,
      tree: parent.tree.sha,
      parents: [parent.sha],
    }),
  );
  // On a lost response do not delete, adopt the current ref or repeat the
  // creation. Its persistent ref is the visible reconciliation hold.
  hub.create("git/refs", { ref: `refs/${ref}`, sha: commit.sha });
  if (lockHead(hub, ref) !== commit.sha) {
    throw new OpsError("exclusive execution could not be confirmed");
  }
  return commit.sha;
}
function releaseLock(hub: Hub, ref: string, token: string): void {
  if (lockHead(hub, ref) !== token) {
    throw new OpsError("execution ownership lost; refusing unlock");
  }
  hub.remove(`git/refs/${ref}`);
}

export { acquire, integrationLock, issueLock, lockHead, releaseLock };
