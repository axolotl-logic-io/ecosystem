// What the reviewer's states are built from: the results they answer with,
// the shape of a state, and a script check's state. machine.ts joins the
// states; entries/review.ts and the prelude build them with these.

import type { StateSpec } from "../machine.ts";
import type { ReviewerData, ReviewerState } from "./locate.ts";

// The results the states answer with: a check's `ok`, the claim's
// `not-ours`, the prep's `empty`, a session's `replied` or `failed`, and
// what the posted lens comments found.
type ReviewerResult =
  | "ok"
  | "not-ours"
  | "empty"
  | "replied"
  | "failed"
  | "clean"
  | "blocking"
  | "lens-failed";

type ReviewerSpec = StateSpec<ReviewerState, ReviewerResult, ReviewerData>;

type Payload = Readonly<Record<string, unknown>>;

// A script check named `name`, on the issue, with `payload`'s fields.
function check(
  name: string,
  payload: (data: ReviewerData) => Payload,
  on: ReviewerSpec["on"],
): ReviewerSpec {
  return {
    kind: "script",
    effect: (data: ReviewerData) => ({
      kind: "check",
      check: name,
      payload: { number: data.issue, ...payload(data) },
    }),
    on,
  };
}

export type { ReviewerResult, ReviewerSpec };
export { check };
