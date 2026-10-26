// What the Land flow tests stand on before a Gatekeeper runs: issue ISSUE
// implemented by the real Developer buddy into PR #8, and approvals of its
// head as GitHub and the item's records would hold them. A Verify approval
// is the landing account's APPROVED review of the head plus the passed
// Verify attempt and result records that submitted it, written by the
// landing account as the real Verify writes them; a person's review is
// their submitted review alone. Nothing here runs a task, an op or the
// ledger: the buddy reads all of it back through the fake gh.
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { loadConfig } from "../../../src/config.ts";
import type { Attempt, Result } from "../../../src/tasks/records.ts";
import { recordBody } from "../../../src/tasks/records.ts";
import type {
  FakeReview,
  World,
} from "../../support/signals/fake-github-world.ts";
import { LANDING, REPO } from "../../support/signals/signal-test-kit.ts";
import type {
  BuddyChoice,
  BuddyOutcome,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { ISSUE, marked } from "./buddy-flow-test-kit.ts";

const IMPLEMENTS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count the widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
// Implement's fresh hardening session, should its action run one; it
// finds nothing to change.
const HARDENS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Checked the count." },
};
// Implement begins on the first poll; the second stops the run.
const DEVELOPER_POLLS = 2;
const PR = 8;
const REQUIREMENTS = /^sha256:(?<inputs>[0-9a-f]{64})$/u;
const IMPLEMENTED = z.looseObject({
  kind: z.literal("attempt"),
  binding: z.looseObject({
    task: z.literal("implement"),
    requirements: z.string(),
  }),
});
const GATEKEEPER: BuddyChoice = { role: "gatekeeper", tasks: ["land"] };
const POSTED_FROM = Date.parse("2026-10-25T12:00:00Z");
const MS_PER_SECOND = 1000;

function postedAt(id: number): string {
  return new Date(POSTED_FROM + id * MS_PER_SECOND).toISOString();
}

// The Developer implements the started issue; resolves the PR head.
async function implemented(box: Machine, signal: AbortSignal): Promise<string> {
  const developer = await box.runBuddy(
    [IMPLEMENTS, HARDENS],
    DEVELOPER_POLLS,
    { role: "developer", tasks: ["implement"] },
    signal,
  );
  signal.throwIfAborted();
  if (developer.status !== 0) {
    throw new Error(`the Developer failed: ${developer.stderr}`);
  }
  const pr = box.world().pulls?.find((pull) => pull.number === PR);
  if (pr === undefined) {
    throw new Error("Implement opened no PR #8");
  }
  return box.git(["rev-parse", `agent/issue-${ISSUE}`]);
}

// The revision `head` of the machine's item as the buddy computes it: its
// trusted inputs, as Implement's attempt bound them, and the repository's
// checking policy.
function revisionOf(
  box: Machine,
  head: string,
): { code: string; inputs: string; policy: string } {
  const attempt = marked(box.world(), "task-result")
    .map((row) => IMPLEMENTED.safeParse(row))
    .find((row) => row.success);
  const { inputs } =
    REQUIREMENTS.exec(attempt?.data?.binding.requirements ?? "")?.groups ?? {};
  const cfg = loadConfig(path.join(box.root, "repo.json"));
  const policy = cfg.policyBinding?.digest;
  if (inputs === undefined || policy === undefined) {
    throw new Error("the machine's revision can't be computed");
  }
  return { code: head, inputs, policy };
}

// A review of PR #8 by `author`, appended as GitHub would store it.
function review(
  world: World,
  author: string,
  state: FakeReview["state"],
  head: string,
): number {
  const pull = world.pulls?.find((item) => item.number === PR);
  if (pull === undefined) {
    throw new Error("no PR #8 to review");
  }
  const id = world.nextId;
  world.nextId += 1;
  pull.reviews ??= [];
  pull.reviews.push({
    id,
    author,
    state,
    commitId: head,
    body: "",
    submittedAt: postedAt(id),
  });
  return id;
}

function landingComment(world: World, body: string): void {
  const issue = world.issues.find((item) => item.number === ISSUE);
  if (issue === undefined) {
    throw new Error("no issue to record on");
  }
  issue.comments.push({
    id: world.nextId,
    author: LANDING,
    body,
    editor: null,
    createdAt: postedAt(world.nextId),
  });
  world.nextId += 1;
}

// Verify's verdict on `head`, checked on the target as it is now: the landing
// account's review and the passed (APPROVED) or refused
// (CHANGES_REQUESTED) Verify run that submitted it, caused by Implement's
// result.
function verified(
  box: Machine,
  head: string,
  verdict: "passed" | "refused",
): void {
  const revision = revisionOf(box, head);
  const target = box.git(["rev-parse", "main"]);
  box.change((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    const implement = issue?.comments.findLast((comment) =>
      comment.body.includes('"kind":"result"'),
    );
    if (implement === undefined) {
      throw new Error("Implement recorded no result");
    }
    let state: FakeReview["state"] = "APPROVED";
    let blocking = 0;
    if (verdict === "refused") {
      state = "CHANGES_REQUESTED";
      blocking = 1;
    }
    const id = review(world, LANDING, state, head);
    const attempt: Attempt = {
      version: 2,
      kind: "attempt",
      binding: {
        workItem: { repo: REPO, number: ISSUE },
        task: "verify",
        target: { branch: "main", commit: target },
        revision,
      },
      run: { id: randomUUID(), previous: null },
      buddyRun: randomUUID(),
      cause: { signal: `result:${implement.id}`, recordId: implement.id },
    };
    const result: Result = {
      ...attempt,
      kind: "result",
      verdict,
      receipt: {
        summary: `Verify reviewed ${head}`,
        evidence: {
          review: { id, pr: PR, commit: head, state },
          blocking,
          nits: 0,
          security: false,
        },
      },
    };
    landingComment(world, recordBody(attempt));
    landingComment(world, recordBody(result));
  });
}

// The gh calls of `verb` (such as ["pr", "merge"]) the machine made.
function callsOf(box: Machine, verb: readonly string[]): string[][] {
  return box
    .calls()
    .map((call) => call.args)
    .filter((args) => verb.every((part, at) => args[at] === part));
}

// The Land actions `outcome`'s run began.
function landsOf(outcome: BuddyOutcome): BuddyOutcome["actions"] {
  return outcome.actions.filter(
    (action) =>
      action.task === "land" &&
      action.buddyRun === outcome.run.id &&
      action.state !== "waiting",
  );
}

// Keeps a failing test's machine for inspection; removes a passing one's.
function retainOnFailure(box: Machine, passed: boolean, what: string): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`${what} fixture retained: ${box.root}\n`);
}

export {
  callsOf,
  GATEKEEPER,
  implemented,
  landsOf,
  PR,
  retainOnFailure,
  review,
  verified,
};
