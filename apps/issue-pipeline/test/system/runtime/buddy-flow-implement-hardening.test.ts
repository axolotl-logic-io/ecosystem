// Implement hardens its own change: after the writing session, a second
// Developer session, in a pi process and session file of its own and with the
// hardening prompt page, examines the branch without the writing session's
// conversation, and only then does the development account open the PR. A
// hardening that can't finish fails Implement before any PR, and no start
// retries Implement for the same requirements. Only gh (fake-gh.ts) and pi
// (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import type { Machine, PlannedSession } from "./buddy-flow-test-kit.ts";
import { DEVELOPER, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const BRANCH = `agent/issue-${ISSUE}`;
const WRITES: PlannedSession = {
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
const HARDENS: PlannedSession = {
  ...WRITES,
  commit: {
    file: "counter.test.txt",
    content: "0 widgets counts as 0\n",
    message: "Pin the empty count",
  },
  reply: { outcome: "done", summary: "Added the empty-count case." },
};
const CANNOT: PlannedSession = {
  ...WRITES,
  commit: null,
  reply: {
    outcome: "cannot",
    reason: "Should a negative count be refused? The issue doesn't say.",
  },
};
const HARDENING_PAGE = "# Pipeline prompt: Developer hardening";
const WRITING_PAGE = "# Pipeline prompt: Developer\n";
const FRESH = /This is a fresh session/u;
const UNANSWERED = /negative count/u;
const POLLS = 2;

// The value pi was launched with for `flag`.
function flagOf(args: readonly string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`hardening flow machine kept at ${box.root}\n`);
}

test("Implement hardens its change in a fresh session before it opens the PR", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const { status, actions } = await box.runBuddy(
      [WRITES, HARDENS],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(status, 0);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(actions.length, 1);
    assert.equal(action.verdict, "passed", action.reason ?? "");
    // Two sessions of one action, the second in the hardening phase.
    assert.deepEqual(
      action.sessions.map((session) => [
        session.agent,
        session.phase,
        session.commits,
        session.outcome,
      ]),
      [
        ["issue-pipeline-developer", null, true, "ok"],
        ["issue-pipeline-developer", "hardening", true, "ok"],
      ],
    );
    // Each was its own pi process with its own session file and page; the
    // hardening's task says it is fresh and carries nothing the writing
    // session said.
    const [writing, hardening] = box.launches();
    assert.ok(writing !== undefined && hardening !== undefined);
    assert.notEqual(
      flagOf(writing.args, "--session"),
      flagOf(hardening.args, "--session"),
    );
    const writingPage = flagOf(writing.args, "--append-system-prompt");
    const hardeningPage = flagOf(hardening.args, "--append-system-prompt");
    assert.ok(writingPage.startsWith(WRITING_PAGE));
    assert.ok(hardeningPage.startsWith(HARDENING_PAGE));
    assert.match(hardening.prompt, FRESH);
    assert.equal(hardening.prompt.includes("Counted the widgets."), false);
    // The delivered head is the hardening's commit on the writing's.
    const head = box.git(["rev-parse", BRANCH]);
    assert.equal(
      box.git(["log", "-1", "--format=%s", head]),
      "Pin the empty count",
    );
    assert.equal(
      box.git(["log", "-1", "--format=%s", `${head}^`]),
      "Count the widgets",
    );
    // The development account's ready PR closes the issue.
    assert.deepEqual(
      box
        .world()
        .pulls?.map((pull) => [
          pull.head,
          pull.author,
          pull.isDraft,
          pull.body,
        ]),
      [[BRANCH, DEVELOPER, false, `Closes #${ISSUE}`]],
    );
    const results = marked(box.world(), "task-result");
    assert.deepEqual(results.at(-1)?.receipt, {
      summary: "Counted the widgets.",
      produced: { code: head },
    });
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a hardening that can't finish fails Implement before any PR, and a start never retries it", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const first = await box.runBuddy(
      [WRITES, CANNOT],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(first.status, 0);
    const [action] = first.actions;
    assert.ok(action !== undefined);
    assert.equal(first.actions.length, 1);
    assert.equal(action.verdict, "failed");
    assert.match(action.reason ?? "", UNANSWERED);
    assert.deepEqual(box.world().pulls, []);
    assert.deepEqual(
      marked(box.world(), "task-result").map((item) => [
        item.kind,
        item.verdict ?? null,
      ]),
      [
        ["attempt", null],
        ["result", "failed"],
      ],
    );
    // A new activation sees the start spent by the failed attempt: no new
    // action, attempt or session for these requirements.
    const before = marked(box.world(), "task-result");
    const again = await box.runBuddy([], POLLS, undefined, signal);
    assert.equal(again.status, 0);
    assert.deepEqual(
      again.actions.map((item) => item.id),
      [action.id],
    );
    assert.equal(again.run.loops[0]?.action, null);
    assert.deepEqual(marked(box.world(), "task-result"), before);
    assert.equal(box.launches().length, 2);
    passed = true;
  } finally {
    keep(box, passed);
  }
});
