// Closing the parents of split issues: the sweep asks ops to close each parent
// whose sub-issues are all done, once its own issue's stages have run.

import type { OpLaunch } from "./types.ts";

// One close request per parent, keyed by the parent's number.
function closeParentLaunches(parents: readonly number[]): OpLaunch[] {
  return parents.map(
    (n): OpLaunch => ({
      kind: "op",
      name: `p${n}-close`,
      op: "close-parent",
      payload: { number: n },
    }),
  );
}

// How many of the replies to closeParentLaunches closed their parent.
function parentsClosed(
  replies: readonly Readonly<Record<string, unknown>>[],
): number {
  return replies.filter(({ ok, closed }) => ok === true && closed === true)
    .length;
}

export { closeParentLaunches, parentsClosed };
