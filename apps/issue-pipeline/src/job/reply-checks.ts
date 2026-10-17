// A session's reply check: a role may name a check its session's reply is
// put through before the session ends. The registry (src/roles/registry.ts)
// makes that check from the role's checks, bounded to
// REPLY_CHECK_ROUNDS findings, and the job's control answers the session's
// `structured_output` with it over the control socket (control.ts), so the
// session can fix what it finds and reply again.

import type { SessionEffect } from "../roles/machine.ts";
import type { ReplyCheckReply } from "./control-protocol.ts";
import type { Effects, ReplyCheck } from "./run-step.ts";

// How many times a session's reply is checked while it runs and found
// wanting; after that its reply passes to the role's checks as it is, so a
// session that can't satisfy the check still ends.
const REPLY_CHECK_ROUNDS = 3;

// The live sessions' reply checks, by launch key.
interface ReplyChecks {
  // Checks session `key`'s replies with `check` until the returned function
  // is called.
  add: (key: string, check: ReplyCheck) => () => void;
  // What session `key`'s check finds in `reply`: null problems when the
  // session has no check, or its check throws.
  answer: (key: string, reply: unknown) => Promise<ReplyCheckReply>;
}

// The check a session's reply is put through before the session ends, as
// `effect` names it, or undefined when it names none: the role's check
// `check` with the reply added to its payload. A `bad` result is a finding,
// its reply the findings' text; any other result, a failed check and every
// check after the last round pass.
function replyCheckOf(
  check: Effects["check"],
  effect: SessionEffect,
): ReplyCheck | undefined {
  const { replyCheck } = effect;
  if (replyCheck === undefined) {
    return undefined;
  }
  let rounds = 0;
  return async (reply: unknown): Promise<string | null> => {
    if (rounds >= REPLY_CHECK_ROUNDS) {
      return null;
    }
    const outcome = await check({
      kind: "check",
      check: replyCheck.check,
      payload: { ...replyCheck.payload, reply },
    });
    if (!outcome.ok || outcome.name !== "bad") {
      return null;
    }
    rounds += 1;
    return String(outcome.reply);
  };
}

function replyChecksOf(): ReplyChecks {
  const checks = new Map<string, ReplyCheck>();
  return {
    add: (key: string, check: ReplyCheck): (() => void) => {
      checks.set(key, check);
      return (): void => {
        if (checks.get(key) === check) {
          checks.delete(key);
        }
      };
    },
    answer: (key: string, reply: unknown): Promise<ReplyCheckReply> => {
      const check = checks.get(key);
      if (check === undefined) {
        return Promise.resolve({ problems: null });
      }
      return check(reply).then(
        (problems: string | null): ReplyCheckReply => ({ problems }),
        (): ReplyCheckReply => ({ problems: null }),
      );
    },
  };
}

export type { ReplyChecks };
export { REPLY_CHECK_ROUNDS, replyCheckOf, replyChecksOf };
