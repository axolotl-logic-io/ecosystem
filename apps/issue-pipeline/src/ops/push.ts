// The push ops: push pushes the issue's code branch; exit-push is the push
// a writer's stage job makes as it exits. Once the saved state records the
// code landed, they refuse: nothing of the issue's is left to push.

import { z } from "zod";
import type { PushResult } from "../checkouts.ts";
import { PushDiverged, push } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { readWriteAuthority } from "../write-authority.ts";

const PUSH_REQUEST = z.looseObject({
  number: z.number().int().positive(),
});

// Throws when issue `n`'s saved state records its code landed, since `op`
// would push code.
function refuseOnceLanded(cfg: Config, n: number, op: string): void {
  const { codeWritable } = readWriteAuthority(cfg, n);
  if (!codeWritable) {
    throw new OpsError(`#${n}'s code merged, so ${op} can't push code`);
  }
}

// A push's reply: the head and what the work changes, and, when the branch
// held another worker's commits, the recovery branch that keeps this one's.
type PushReply = PushResult & {
  diverged?: { branch: string; recovery: string };
};

// Pushes the issue's code branch for `op`. Once the saved state records the
// code landed, or binds another branch than the assigned one, it refuses.
// A diverged branch is a determined answer, not an error: both workers'
// commits are kept, and the caller decides what to report.
function pushFor(cfg: Config, request: unknown, op: string): PushReply {
  const { number } = parseRequest(PUSH_REQUEST, op, request);
  refuseOnceLanded(cfg, number, op);
  try {
    return push(cfg, number, op);
  } catch (error) {
    if (!(error instanceof PushDiverged)) {
      throw error;
    }
    const { branch, recovery, headSha } = error;
    return { headSha, codeChanged: true, diverged: { branch, recovery } };
  }
}

function pushOp(cfg: Config, request: unknown): PushReply {
  return pushFor(cfg, request, "push");
}

export { pushOp, refuseOnceLanded };
