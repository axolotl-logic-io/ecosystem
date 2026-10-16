// A stacked issue in the stages (#268): one whose branch starts on another
// issue's branch, its prerequisite, which st.stackedOn names until it
// merges. The ops that measure or move the branch get st.stackedOn with
// their request; an unstacked issue's requests carry no stackedOn. A sync's
// reply says what the issue is stacked on after it.

import type { IssueState } from "../types.ts";
import { isRecord } from "./checks-reply.ts";
import type { OpLaunch, StageState } from "./types.ts";

type StackedOn = NonNullable<IssueState["stackedOn"]>;

// The request fields that tell an op what the issue is stacked on: none for
// an unstacked issue.
function stackFields(
  stackedOn: StackedOn | null | undefined,
): Readonly<Record<string, unknown>> {
  if (stackedOn === null || stackedOn === undefined) {
    return {};
  }
  return { stackedOn };
}

// The request for an op on the issue's branch: the issue's number, `fields`,
// and what the issue is stacked on, if it is.
function branchPayload(
  state: StageState,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { number: state.n, ...fields, ...stackFields(state.st.stackedOn) };
}

// The prepare-review request for the issue's diff, with `fields` such as its
// tag and the head it is diffed since.
function prepareLaunch(
  state: StageState,
  fields: Readonly<Record<string, unknown>>,
): OpLaunch {
  const payload = branchPayload(state, fields);
  return { kind: "op", name: "prep", op: "prepare-review", payload };
}

// A reply's stackedOn: undefined when it has none, which leaves the issue's
// as it is, and otherwise null (unstacked) or what it is stacked on now.
function stackedOnOf(
  reply: Readonly<Record<string, unknown>>,
): StackedOn | null | undefined {
  const { stackedOn } = reply;
  if (stackedOn === null) {
    return null;
  }
  if (isRecord(stackedOn)) {
    const { issue, headSha } = stackedOn;
    if (typeof issue === "number" && typeof headSha === "string") {
      return { issue, headSha };
    }
  }
  return undefined;
}

// What a sync rebases the issue onto, as comments and the log name it: the
// prerequisite's branch while stacked, the base branch otherwise.
function syncOnto(
  stackedOn: StackedOn | null | undefined,
  baseBranch: string,
): string {
  if (stackedOn === null || stackedOn === undefined) {
    return baseBranch;
  }
  return `agent/issue-${stackedOn.issue} (#${stackedOn.issue})`;
}

export type { StackedOn };
export { branchPayload, prepareLaunch, stackedOnOf, stackFields, syncOnto };
