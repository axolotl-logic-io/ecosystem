// Author on its own start: `start:author` on the issue wakes the Developer's
// Author for the current requirements, whose one read-only Author session
// writes the issue's behaviour as Gherkin; the landing account posts it as
// the pipeline's author comment. That comment is no trusted input, so the
// requirements Implement binds stay those the issue's author wrote, and
// Implement doesn't wait for Author. Questions instead of Gherkin refuse, and
// the spent start never retries Author. The signal inbox delivers the start
// (src/signals/inbox.ts); only gh (fake-gh.ts) and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import type { World } from "../../support/signals/fake-github-world.ts";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import { records, results } from "./buddy-flow-review-test-kit.ts";
import type {
  BuddyChoice,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { HARDENING, HUMAN, ISSUE, machine } from "./buddy-flow-test-kit.ts";

const AUTHOR_PAGE = "# Pipeline prompt: Author";
const GHERKIN =
  "Feature: Widget counter\n  Scenario: Count the widgets\n    Given 3 widgets\n    Then the count is 3";
const GHERKIN_MARK = `<!-- issue-pipeline:${ISSUE}:gherkin -->`;
const QUESTIONS_MARK = `<!-- issue-pipeline:${ISSUE}:author-questions -->`;
const AUTHOR_ROLE = "<!-- agent-pipeline:comment role=author -->";
const AUTHORS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: {
    outcome: "gherkin",
    gherkin: GHERKIN,
    assumptions: ["A widget is counted once."],
    changed: true,
  },
};
const ASKS: PlannedSession = {
  ...AUTHORS,
  reply: {
    outcome: "needs-info",
    questions: ["Do broken widgets count?"],
  },
};
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
const AUTHOR: BuddyChoice = { role: "developer", tasks: ["author"] };
const BOTH: BuddyChoice = { role: "developer", tasks: ["author", "implement"] };
// Author on one poll, Implement on the next; the third stops.
const BOTH_POLLS = 3;
const POLLS = 2;
const ASSIGNEES = `repos/acme/widgets/issues/${ISSUE}/assignees`;

function isAssigneesPath(arg: string): boolean {
  return arg === ASSIGNEES;
}

// Issue ISSUE with exactly `labels`, each applied by the human.
function labelled(labels: readonly string[]): (world: World) => void {
  return (world: World): void => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    issue.labels = [...labels];
    issue.events = labels.map((label, at) => ({
      id: world.nextId + at,
      event: "labeled",
      label,
      actor: HUMAN,
      viaApp: false,
      createdAt: "2026-10-25T10:00:00Z",
    }));
    world.nextId += labels.length;
  };
}

// The issue's comments carrying `mark`.
function commentsWith(
  box: Machine,
  mark: string,
): World["issues"][number]["comments"] {
  return (
    box
      .world()
      .issues.find((item) => item.number === ISSUE)
      ?.comments.filter((comment) => comment.body.includes(mark)) ?? []
  );
}

// The value pi was launched with for `flag`.
function flagOf(args: readonly string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`Author flow machine kept at ${box.root}\n`);
}

test("Author posts the issue's Gherkin as the pipeline's author comment, and Implement binds the same requirements", async ({
  signal,
}) => {
  const box = machine(labelled(["start:author", "start:implement"]));
  let passed = false;
  try {
    const run = await box.runBuddy(
      [AUTHORS, WRITES, HARDENING],
      BOTH_POLLS,
      BOTH,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    const author = run.actions.find((action) => action.task === "author");
    const implement = run.actions.find((action) => action.task === "implement");
    assert.ok(author !== undefined && implement !== undefined);
    assert.equal(author.verdict, "passed", author.reason ?? "");
    assert.equal(implement.verdict, "passed", implement.reason ?? "");
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.labels,
      [],
    );
    // One read-only Author session on the Author's page and model role.
    assert.deepEqual(
      author.sessions.map((session) => [
        session.agent,
        session.phase,
        session.commits,
      ]),
      [["issue-pipeline-author", null, false]],
    );
    const [launch] = box.launches();
    assert.ok(launch !== undefined);
    assert.ok(
      flagOf(launch.args, "--append-system-prompt").startsWith(AUTHOR_PAGE),
    );
    // The landing account's one Gherkin comment, signed by the author role.
    const [gherkin, ...more] = commentsWith(box, GHERKIN_MARK);
    assert.deepEqual(more, []);
    assert.equal(gherkin?.author, LANDING);
    assert.ok(gherkin?.body.includes(AUTHOR_ROLE));
    assert.ok(gherkin?.body.includes(`\`\`\`gherkin\n${GHERKIN}\n\`\`\``));
    assert.ok(gherkin?.body.includes("- A widget is counted once."));
    // Author wrote no code; Implement bound exactly Author's requirements,
    // which the Gherkin comment didn't change.
    assert.ok("requirements" in author.binding);
    assert.ok("requirements" in implement.binding);
    assert.equal(implement.binding.requirements, author.binding.requirements);
    assert.deepEqual(
      results(box).map((result) => [result.binding.task, result.verdict]),
      [
        ["author", "passed"],
        ["implement", "passed"],
      ],
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("Author's questions refuse, and its spent start never retries it", async ({
  signal,
}) => {
  const box = machine(labelled(["start:author"]));
  let passed = false;
  try {
    const first = await box.runBuddy([ASKS], POLLS, AUTHOR, signal);
    assert.equal(first.status, 0, first.stderr);
    const [author] = first.actions;
    assert.ok(author !== undefined);
    assert.equal(first.actions.length, 1);
    assert.equal(author.verdict, "refused");
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.labels,
      [],
    );
    assert.ok(first.stderr.includes('"outcome":"refused"'), first.stderr);
    assert.ok(first.stderr.includes(author.id), first.stderr);
    const [questions] = commentsWith(box, QUESTIONS_MARK);
    assert.equal(questions?.author, LANDING);
    assert.ok(questions?.body.includes("- Do broken widgets count?"));
    assert.deepEqual(commentsWith(box, GHERKIN_MARK), []);
    assert.deepEqual(box.git(["branch", "--list", `agent/issue-${ISSUE}`]), "");
    const before = records(box);
    assert.equal(
      before.filter((record) => record.kind === "attempt").length,
      1,
    );
    assert.equal(before.filter((record) => record.kind === "result").length, 1);
    const again = await box.runBuddy([], POLLS, AUTHOR, signal);
    assert.equal(again.status, 0);
    assert.deepEqual(
      again.actions.map((action) => action.id),
      [author.id],
    );
    assert.deepEqual(records(box), before);
    assert.equal(box.launches().length, 1);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("Author writes Gherkin on an issue assigned to a person, and neither backs off nor assigns", async ({
  signal,
}) => {
  const box = machine((world: World): void => {
    labelled(["start:author"])(world);
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue !== undefined) {
      issue.assignees = [HUMAN];
    }
  });
  let passed = false;
  try {
    const run = await box.runBuddy([AUTHORS], POLLS, AUTHOR, signal);
    assert.equal(run.status, 0, run.stderr);
    const [author] = run.actions;
    assert.equal(author?.verdict, "passed", author?.reason ?? run.stderr);
    assert.deepEqual(
      box.calls().filter((call) => call.args.some(isAssigneesPath)),
      [],
    );
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.assignees,
      [HUMAN],
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("Author clears only its consumed start label, leaving other labels and durable records", async ({
  signal,
}) => {
  const labels = ["start:author", "start:implement", "task:label:docs"];
  const box = machine(labelled(labels));
  try {
    const run = await box.runBuddy([AUTHORS], POLLS, AUTHOR, signal);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    const issue = box.world().issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.labels, labels.slice(1));
    assert.ok(
      issue?.events.some(
        (event) =>
          event.event === "unlabeled" &&
          event.label === "start:author" &&
          event.actor === LANDING,
      ),
    );
    assert.equal(commentsWith(box, "<!-- agent-pipeline:signal").length, 2);
    assert.equal(records(box).length, 2);
  } finally {
    box.cleanup();
  }
});

test("Author leaves a newer start application in place when its old request completes", async ({
  signal,
}) => {
  const box = machine(labelled(["start:author"]));
  try {
    const run = await box.runBuddy(
      [{ ...AUTHORS, change: "reapply-author-start" }],
      POLLS,
      AUTHOR,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    const issue = box.world().issues.find((item) => item.number === ISSUE);
    assert.deepEqual(issue?.labels, ["start:author"]);
    assert.equal(issue?.events.at(-1)?.event, "labeled");
    assert.equal(issue?.events.at(-1)?.actor, HUMAN);
    assert.equal(results(box).length, 1);
  } finally {
    box.cleanup();
  }
});

test("a determined Author failure clears its spent start without enabling a retry", async ({
  signal,
}) => {
  const box = machine(labelled(["start:author"]));
  try {
    const run = await box.runBuddy(
      [{ ...AUTHORS, reply: { outcome: "invalid" } }],
      POLLS,
      AUTHOR,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "failed");
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.labels,
      [],
    );
    assert.equal(results(box)[0]?.verdict, "failed");
    const again = await box.runBuddy([], POLLS, AUTHOR, signal);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(box.launches().length, 1);
    assert.equal(records(box).length, 2);
  } finally {
    box.cleanup();
  }
});

test("a label deletion failure warns without changing Author's confirmed result", async ({
  signal,
}) => {
  const box = machine((world) => {
    labelled(["start:author"])(world);
    world.refuseLabelChanges = true;
  });
  try {
    const run = await box.runBuddy([AUTHORS], POLLS, AUTHOR, signal);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed");
    assert.equal(run.actions[0]?.ownership.state, "released");
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.labels,
      ["start:author"],
    );
    assert.equal(results(box)[0]?.verdict, "passed");
    assert.ok(run.stderr.includes('"state":"warning"'), run.stderr);
    assert.ok(
      run.stderr.includes("could not clear the completed task's start label"),
      run.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("Author retains its start label when its result cannot be confirmed", async ({
  signal,
}) => {
  const box = machine(labelled(["start:author"]));
  try {
    const run = await box.runBuddy(
      [{ ...AUTHORS, change: "posts-fail" }],
      POLLS,
      AUTHOR,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "unknown");
    assert.equal(run.actions[0]?.ownership.state, "retained");
    assert.deepEqual(
      box.world().issues.find((item) => item.number === ISSUE)?.labels,
      ["start:author"],
    );
    assert.deepEqual(results(box), []);
  } finally {
    box.cleanup();
  }
});
