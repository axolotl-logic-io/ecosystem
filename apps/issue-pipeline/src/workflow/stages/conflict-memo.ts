// What a conflict resolution carries between its steps (sync-conflict.ts):
// the conflicting files and the rebase's target, and once the resolver has
// replied, its reply, signature and error. The carry is JSON-safe and never
// saved; these guards read it back.

import type { Signature } from "../signing.ts";
import type { FixOutput } from "./checks-reply.ts";
import { fixOf, isRecord, isStrings } from "./checks-reply.ts";
import type { ConflictTarget } from "./conflict-target.ts";
import { targetOf } from "./conflict-target.ts";
import { nullableText, signatureOf } from "./reply-guards.ts";
import type { StageState } from "./types.ts";

// A rebase stopped on conflicts in `files`, onto `baseSha`.
interface Conflict {
  files: string[];
  baseSha: unknown;
  target: ConflictTarget;
}

// What the resolution keeps between its steps: the conflicting files, the
// target, and once the resolver has replied, its reply (null when it
// failed), signature and error.
interface ConflictMemo {
  files: string[];
  target: ConflictTarget;
  fix: FixOutput | null;
  by: Signature;
  error: string | null;
}

// The files and target carried between the steps; anything else is a bug in
// the sweep's loop.
function carriedOf(state: StageState): Omit<Conflict, "baseSha"> {
  const { carry } = state;
  if (isRecord(carry)) {
    const { files, target } = carry;
    if (isStrings(files)) {
      return { files, target: targetOf(target) };
    }
  }
  throw new Error("conflict: expected the conflicting files");
}

function memoOf(state: StageState): ConflictMemo {
  const { files, target } = carriedOf(state);
  const { carry } = state;
  if (isRecord(carry)) {
    const { fix, by, error } = carry;
    const signature = signatureOf(by);
    if (signature !== null && nullableText(error)) {
      return { files, target, fix: fixOf(fix), by: signature, error };
    }
  }
  throw new Error("conflict: expected the resolver's reply");
}

export type { Conflict, ConflictMemo };
export { carriedOf, memoOf };
