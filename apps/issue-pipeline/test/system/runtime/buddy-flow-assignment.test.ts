// Issue assignment through the built buddy (src/issue-assignment.ts): if a
// person is assigned to an issue, Implement and Fix leave it to them and
// wait without a claim, a post or a spent signal, and the same start runs
// once the person is unassigned. Once Implement or Fix records an attempt,
// the development account is assigned, and on settle it removes only
// itself; an attempt that is never recorded assigns nothing. The machine
// accounts never cause a back-off, a failed assignment never fails the run,
// and Verify and Land neither back off nor assign. Only gh (fake-gh.ts) and
// pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { World } from "../../support/signals/fake-github-world.ts";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import {
  callsOf,
  GATEKEEPER,
  implemented as implementedHead,
  retainOnFailure,
  verified,
} from "./buddy-flow-land-test-kit.ts";
import {
  BRANCH,
  implemented,
  verifyRequestsChanges,
} from "./buddy-flow-review-test-kit.ts";
import type {
  BuddyChoice,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import {
  applyStart,
  DEVELOPER,
  HARDENING,
  HUMAN,
  ISSUE,
  machine,
  marked,
} from "./buddy-flow-test-kit.ts";

const COUNTS: PlannedSession = {
  commit: { file: "counter.txt", content: "3 widgets\n", message: "Count" },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
const FIX: PlannedSession = {
  commit: { file: "counter.txt", content: "3\n", message: "Count a number" },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted with a number.", replies: [] },
};
const VERIFY: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "Read the whole diff.", findings: [] },
};
const FIXER: BuddyChoice = { role: "developer", tasks: ["fix"] };
const VERIFIER: BuddyChoice = { role: "gatekeeper", tasks: ["verify"] };
// The task acts, or waits, on the first poll; the second stops the run.
const POLLS = 2;
// Verify acts on the first poll, finds its binding settled on the second
// and stops on the third.
const VERIFY_POLLS = 3;
const IMPLEMENT_SESSIONS = 2;
const ASSIGNEES = `repos/acme/widgets/issues/${ISSUE}/assignees`;
const LEFT_TO_HUMAN = `#${ISSUE} is assigned to ${HUMAN}, so the pipeline leaves it to them`;
// The landing account as GitHub might spell it, to show the comparison
// ignores case.
const LANDING_SPELLED = LANDING.toUpperCase();
const ASSIGN_FAILED = `could not assign ${DEVELOPER} to #${ISSUE}`;
const UNASSIGN_FAILED = `could not unassign ${DEVELOPER} from #${ISSUE}`;
const WRITE_FLAGS = ["--input", "-f", "-F", "--field", "--raw-field"];
const QUERY = /^query=query[ ({]/u;
const WARNING = /"state":"warning"/u;
const HELD = /"state":"held"/u;
const NO_HEAD_TO_FIX = /^start:fix event \d+ not accepted: PR #\d+ is MERGED/u;
const UNREADABLE = `the assignees of #${ISSUE} are unreadable`;
const SIGNAL = z.looseObject({ id: z.string() });
const LOGGED_WARNING = z.object({
  task: z.string(),
  action: z.uuid(),
  state: z.literal("warning"),
  reason: z.string(),
});

function assignees(world: World): string[] {
  return world.issues.find((item) => item.number === ISSUE)?.assignees ?? [];
}

function assign(box: Machine, logins: string[]): void {
  box.change((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    issue.assignees = logins;
  });
}

// The assignee changes the buddies asked GitHub for, as [login, method].
function assigneeChanges(box: Machine): string[][] {
  return box
    .calls()
    .filter((call) => call.args.includes(ASSIGNEES))
    .map((call) => [call.login, call.args[call.args.indexOf("-X") + 1] ?? ""]);
}

// The method `gh api` call `args` asks for: the one it names, or else POST
// for one that sends fields or input, as gh does, or GET.
function methodOf(args: readonly string[]): string {
  const flag = args.findIndex((arg) => arg === "-X" || arg === "--method");
  if (flag >= 0) {
    return args[flag + 1] ?? "";
  }
  if (args.some((arg) => WRITE_FLAGS.includes(arg))) {
    return "POST";
  }
  return "GET";
}

// The `gh api` calls from the `from`th on that may change GitHub: every
// method but GET, except a GraphQL query, which reads.
function apiWrites(box: Machine, from: number): string[][] {
  return box
    .calls()
    .slice(from)
    .map((call) => call.args)
    .filter(
      (args) =>
        args[0] === "api" &&
        methodOf(args) !== "GET" &&
        !(args[1] === "graphql" && args.some((arg) => QUERY.test(arg))),
    );
}

function issueComments(world: World): number {
  return (
    world.issues.find((item) => item.number === ISSUE)?.comments.length ?? 0
  );
}

test("Implement leaves an issue assigned to a person alone, and runs once they are unassigned", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    assign(box, [HUMAN]);
    const waited = await box.runBuddy(
      [COUNTS, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(waited.status, 0, waited.stderr);
    // It waited, never held, for the person.
    assert.equal(waited.run.loops[0]?.reason, LEFT_TO_HUMAN);
    assert.equal(HELD.test(waited.stderr), false, waited.stderr);
    // No claim, attempt, session or assignment. The inbox's record that it
    // accepted the person's start, which it writes before any admission,
    // is the only write, and nothing spends that signal.
    assert.deepEqual(
      waited.actions.filter((action) => action.state !== "waiting"),
      [],
    );
    assert.deepEqual(marked(box.world(), "coordination"), []);
    assert.deepEqual(marked(box.world(), "task-result"), []);
    assert.deepEqual(box.launches(), []);
    assert.deepEqual(
      apiWrites(box, 0).map((args) => [methodOf(args), args[3]]),
      [["POST", `repos/acme/widgets/issues/${ISSUE}/comments`]],
    );
    const accepted = marked(box.world(), "signal");
    assert.deepEqual(
      accepted.map((record) => record.kind),
      ["accepted"],
    );
    assert.deepEqual(assignees(box.world()), [HUMAN]);

    // The same start runs once the person is unassigned.
    assign(box, []);
    const ran = await box.runBuddy(
      [COUNTS, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(ran.status, 0, ran.stderr);
    const implement = ran.actions.find((action) => action.state !== "waiting");
    assert.equal(implement?.verdict, "passed", ran.stderr);
    assert.equal(implement?.cause.signal, SIGNAL.parse(accepted[0]).id);
    assert.deepEqual(assignees(box.world()), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "assignment back-off");
  }
});

test("Implement holds when the issue's assignees can't be read", async ({
  signal,
}) => {
  const box = machine((world) => {
    world.garbleAssignees = true;
  });
  let passed = false;
  try {
    const run = await box.runBuddy(
      [COUNTS, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      run.run.loops[0]?.reason?.startsWith(UNREADABLE),
      run.run.loops[0]?.reason ?? "",
    );
    assert.equal(HELD.test(run.stderr), true, run.stderr);
    assert.deepEqual(marked(box.world(), "coordination"), []);
    assert.deepEqual(marked(box.world(), "task-result"), []);
    assert.deepEqual(box.launches(), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "unreadable assignees");
  }
});

test("Implement assigns the development account while it runs and removes it when it settles", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const running = box.runBuddy([COUNTS, HARDENING], POLLS, undefined, signal);
    // Fails the test when the account is never seen assigned while it runs.
    await box.when(() => assignees(box.world()).includes(DEVELOPER), {
      signal,
    });
    const run = await running;
    assert.equal(run.status, 0, run.stderr);
    const [implement] = run.actions;
    assert.equal(implement?.verdict, "passed", run.stderr);
    assert.equal(implement?.ownership.state, "released");
    assert.deepEqual(assigneeChanges(box), [
      [DEVELOPER, "POST"],
      [DEVELOPER, "DELETE"],
    ]);
    assert.deepEqual(assignees(box.world()), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "self-assignment");
  }
});

test("the machine accounts as assignees cause no back-off, and settling removes only the development account", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    assign(box, [LANDING_SPELLED, DEVELOPER.toUpperCase()]);
    const run = await box.runBuddy(
      [COUNTS, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.actions[0]?.verdict, "passed", run.stderr);
    // Settling removed the development account alone.
    assert.deepEqual(assignees(box.world()), [LANDING_SPELLED]);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "machine assignee");
  }
});

test("a failed assignment is logged and doesn't fail the run", async ({
  signal,
}) => {
  const box = machine((world) => {
    world.refuseAssigneeChanges = true;
  });
  let passed = false;
  try {
    const run = await box.runBuddy(
      [COUNTS, HARDENING],
      POLLS,
      undefined,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    const [implement] = run.actions;
    assert.equal(implement?.verdict, "passed", run.stderr);
    assert.equal(implement?.ownership.state, "released");
    const warnings = run.stderr
      .trim()
      .split("\n")
      .filter((line) => WARNING.test(line))
      .map((line) => LOGGED_WARNING.parse(JSON.parse(line)));
    assert.deepEqual(
      warnings.map((line) => [line.task, line.action]),
      [
        ["implement", implement?.id],
        ["implement", implement?.id],
      ],
    );
    assert.ok(warnings[0]?.reason.startsWith(ASSIGN_FAILED));
    assert.ok(warnings[1]?.reason.startsWith(UNASSIGN_FAILED));
    assert.deepEqual(assignees(box.world()), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "failed assignment");
  }
});

test("Fix leaves an issue assigned to a person alone", async ({ signal }) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    verifyRequestsChanges(box, item, {
      target: box.git(["rev-parse", "main"]),
      body: "The count must be a number.",
      comments: [],
    });
    assign(box, [HUMAN]);
    const before = box.calls().length;
    const comments = issueComments(box.world());
    applyStart(box, "start:fix");
    const run = await box.runBuddy([FIX], POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      run.actions.filter(
        (action) => action.task === "fix" && action.state !== "waiting",
      ),
      [],
    );
    const loop = run.run.loops.find((entry) => entry.task === "fix");
    assert.equal(loop?.reason, LEFT_TO_HUMAN);
    assert.equal(HELD.test(run.stderr), false, run.stderr);
    // The start's acceptance record is the one new comment and write; Fix
    // made none.
    assert.equal(issueComments(box.world()), comments + 1);
    assert.equal(box.git(["rev-parse", BRANCH]), item.head);
    // Implement's writing and hardening sessions, and no Fix session.
    assert.equal(box.launches().length, IMPLEMENT_SESSIONS);
    assert.deepEqual(apiWrites(box, before), [
      [
        "api",
        "-X",
        "POST",
        `repos/acme/widgets/issues/${ISSUE}/comments`,
        "-f",
        "body=<record>",
        "--silent",
      ],
    ]);
    assert.deepEqual(assignees(box.world()), [HUMAN]);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Fix back-off");
  }
});

test("Verify reviews an issue assigned to a person and leaves its assignees alone", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const head = await implementedHead(box, signal);
    box.change((world) => {
      world.checks = { [head]: [{ name: "ci", bucket: "pass" }] };
    });
    assign(box, [HUMAN]);
    const before = assigneeChanges(box).length;
    applyStart(box, "start:verify");
    const run = await box.runBuddy([VERIFY], VERIFY_POLLS, VERIFIER, signal);
    assert.equal(run.status, 0, run.stderr);
    const verify = run.actions.find(
      (action) => action.task === "verify" && action.state !== "waiting",
    );
    assert.equal(verify?.verdict, "passed", run.stderr);
    assert.equal(assigneeChanges(box).length, before);
    assert.deepEqual(assignees(box.world()), [HUMAN]);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Verify while assigned");
  }
});

test("Land merges an issue assigned to a person and leaves its assignees alone", async ({
  signal,
}) => {
  const box = machine(undefined, { landPermission: true });
  let passed = false;
  try {
    const head = await implementedHead(box, signal);
    verified(box, head, "passed");
    box.change((world) => {
      world.checks = { [head]: [{ name: "ci", bucket: "pass" }] };
    });
    assign(box, [HUMAN]);
    const before = assigneeChanges(box).length;
    applyStart(box, "start:land");
    const run = await box.runBuddy([], POLLS, GATEKEEPER, signal);
    assert.equal(run.status, 0, run.stderr);
    const land = run.actions.find(
      (action) => action.task === "land" && action.state !== "waiting",
    );
    assert.equal(land?.verdict, "passed", run.stderr);
    assert.equal(callsOf(box, ["pr", "merge"]).length, 1);
    assert.equal(assigneeChanges(box).length, before);
    assert.deepEqual(assignees(box.world()), [HUMAN]);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Land while assigned");
  }
});

test("a Fix whose attempt is never recorded changes no assignee", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    verifyRequestsChanges(box, item, {
      target: box.git(["rev-parse", "main"]),
      body: "The count must be a number.",
      comments: [],
    });
    // The PR merged after Verify, so the person's start:fix is refused
    // before any attempt: a merged PR has no head to fix.
    box.change((world) => {
      const pull = world.pulls?.[0];
      if (pull === undefined) {
        throw new Error("the world has no pull request");
      }
      pull.state = "MERGED";
      pull.mergeCommit = item.head;
    });
    const before = assigneeChanges(box).length;
    applyStart(box, "start:fix");
    const run = await box.runBuddy([FIX], POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    const loop = run.run.loops.find((entry) => entry.task === "fix");
    assert.match(loop?.reason ?? run.stderr, NO_HEAD_TO_FIX);
    assert.deepEqual(assigneeChanges(box).slice(before), []);
    assert.deepEqual(assignees(box.world()), []);
    passed = true;
  } finally {
    retainOnFailure(box, passed, "Fix not begun");
  }
});
