// Strict local-origin PR operation fixtures shared by the draft/reopen cases.
import { draftMutationReplies } from "../gh-mutation-fixtures.ts";
import {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
} from "../initial-write-state-fixtures.ts";
import type { OpsFixture } from "../ops-fixtures.ts";
import { opsFixture } from "../ops-fixtures.ts";

const fx: OpsFixture = await opsFixture("pr-ops");
fx.fakeGh.requireReplies();
const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);
const { fakeGh, ask }: OpsFixture = fx;

// The gh calls since the last reply that change GitHub, by src/github.ts's
// own read/write rule.
function writes(): string[][] {
  return fakeGh.writes(ghIsRead);
}

// Runs start-pr on a new branch with no open PR, which opens draft `pr`.
function startPr(n: number, pr: number, extra: object = {}): string {
  fakeGh.reply([
    initialWriteStateReply(n),
    ...draftMutationReplies(n, pr),
    historyReply(n),
    openDraftReply(n, pr, `${fx.root}/origin.git`),
    { when: `repos/o/r/issues/${n}`, stdout: JSON.stringify({ title: "T" }) },
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/o/r/pull/${pr}\n` },
  ]);
  return ask({ op: "start-pr", number: n, ...extra });
}

export { fx, startPr, writes };
