// The push ops: push pushes the issue's code branch; exit-push is the push
// a writer's stage job makes as it exits. Once the saved state records the
// code landed, they refuse: nothing of the issue's is left to push.

import { z } from "zod";
import type { PushResult } from "../checkouts.ts";
import { push } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { readWriteAuthority } from "../write-authority.ts";

const PUSH_REQUEST = z.looseObject({
  number: z.number().int().positive(),
});

type PushOp = (cfg: Config, request: unknown) => PushResult;

// Throws when issue `n`'s saved state records its code landed, since `op`
// would push code.
function refuseOnceLanded(cfg: Config, n: number, op: string): void {
  const { codeWritable } = readWriteAuthority(cfg, n);
  if (!codeWritable) {
    throw new OpsError(`#${n}'s code merged, so ${op} can't push code`);
  }
}

// Pushes the issue's code branch for `op`. Once the saved state records the
// code landed, or binds another branch than the assigned one, it refuses.
function pushFor(cfg: Config, request: unknown, op: string): PushResult {
  const { number } = parseRequest(PUSH_REQUEST, op, request);
  refuseOnceLanded(cfg, number, op);
  return push(cfg, number, op);
}

function pushOp(cfg: Config, request: unknown): PushResult {
  return pushFor(cfg, request, "push");
}

// The push a writer's stage job makes as it exits, of commits its checkout
// holds past the last state save (src/job/exit-push.ts). It is recorded as
// "exit-push", which the next claim may adopt (adopt-push.ts).
function exitPushOp(cfg: Config, request: unknown): PushResult {
  return pushFor(cfg, request, "exit-push");
}

const pushOps: Readonly<Record<string, PushOp>> = {
  push: pushOp,
  "exit-push": exitPushOp,
};

export { pushOps, refuseOnceLanded };
