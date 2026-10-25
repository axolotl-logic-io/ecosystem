// The forward delivery flow through the supported buddy entrypoint, end to
// end on a disposable machine whose trusted repository configuration grants
// Land: a Developer activation implements a human-started issue and hardens
// it in a fresh session; a Gatekeeper activation then integrates the
// hardened revision, reviews its security in its own session, fast-forwards
// the target to it and completes the issue from that Land's own proof. The
// built buddy.mjs runs the real tasks, ops, ledger, push server and Git;
// only gh (fake-gh.ts) and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { LANDING, REPO } from "../signals/signal-test-kit.ts";
import type {
  ActionRun,
  BuddyOutcome,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { DEVELOPER, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

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
const HARDENS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets, checked\n",
    message: "Check the widget count",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Checked the count." },
};
const REVIEWS: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { summary: "No security finding.", finding: null },
};
// Implement and Harden each begin on a poll of their own; the third poll
// finds nothing to do and the fourth stops the run.
const DEVELOPER_POLLS = 4;
// Integrate, Review Security, Land and Complete, then one idle poll.
const GATEKEEPER_POLLS = 6;
const GATEKEEPER_TASKS = 4;
const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const TARGET = z.strictObject({ branch: z.literal("main"), commit: SHA });
const REVISION = z.strictObject({
  code: SHA,
  inputs: z.string().regex(/^[0-9a-f]{64}$/u),
  policy: z.string().regex(/^[0-9a-f]{64}$/u),
});
// A v2 task record in the ledger, as the tests read it back.
const TASK_RECORD = z.looseObject({
  version: z.literal(2),
  kind: z.enum(["attempt", "result"]),
  binding: z.looseObject({
    workItem: z.strictObject({ repo: z.string(), number: z.number() }),
    task: z.string(),
    target: TARGET,
    requirements: z.string().optional(),
    revision: REVISION.optional(),
  }),
  run: z.strictObject({ id: z.uuid(), previous: z.uuid().nullable() }),
  buddyRun: z.uuid(),
  cause: z.strictObject({ signal: z.string(), recordId: z.number() }),
  verdict: z.string().optional(),
  receipt: z.unknown().optional(),
});
const PR_VIEW = z.looseObject({
  number: z.number(),
  state: z.string(),
  mergeCommit: z.looseObject({ oid: SHA }).nullable(),
  headRefOid: SHA,
  author: z.looseObject({ login: z.string() }),
});
const RECORD_MARK = "<!-- agent-pipeline:task-result\n";

type TaskRecord = z.infer<typeof TASK_RECORD> & { id: number; by: string };

// The item's v2 task records with their comment ids and authors, oldest
// first.
function ledger(
  comments: readonly { id: number; author: string; body: string }[],
): TaskRecord[] {
  return comments.flatMap((comment): TaskRecord[] => {
    const start = comment.body.indexOf(RECORD_MARK);
    if (start === -1) {
      return [];
    }
    const [json = ""] = comment.body
      .slice(start + RECORD_MARK.length)
      .split("\n-->");
    const record = TASK_RECORD.parse(JSON.parse(json));
    return [{ ...record, id: comment.id, by: comment.author }];
  });
}

function only<T>(items: readonly T[], what: string): T {
  const [item] = items;
  if (item === undefined || items.length !== 1) {
    throw new Error(`not exactly one ${what}: ${items.length}`);
  }
  return item;
}

// The run's actions by task; each task acted exactly once.
function actionsByTask(outcome: BuddyOutcome): Map<string, ActionRun> {
  const tasks = outcome.actions.map((action) => action.task);
  if (new Set(tasks).size !== tasks.length) {
    throw new Error(`a task acted twice: ${tasks.join(", ")}`);
  }
  return new Map(outcome.actions.map((action) => [action.task, action]));
}

function actionOf(actions: Map<string, ActionRun>, task: string): ActionRun {
  const action = actions.get(task);
  if (action === undefined) {
    throw new Error(`${task} never acted`);
  }
  return action;
}

// What an action left behind that every passed, released action shares.
function settledShape(action: ActionRun): unknown {
  return {
    mode: action.mode,
    state: action.state,
    outcome: action.outcome,
    verdict: action.verdict,
    stop: action.stop,
    ownership: action.ownership,
    reservations: action.reservations.map((item) => item.state),
    preserved: action.preserved,
  };
}

const PASSED_AND_RELEASED = {
  mode: "act",
  state: "ended",
  outcome: "succeeded",
  verdict: "passed",
  stop: null,
  ownership: { state: "released", reason: null },
  preserved: { checkout: null, patches: [] },
};

test("a Developer and a Gatekeeper deliver a started issue from Implement to Complete", async () => {
  const box = machine(undefined, { landPermission: true });
  try {
    const target = box.git(["rev-parse", "main"]);

    // The Developer: Implement, then a fresh Harden session.
    const developer = await box.runBuddy(
      [IMPLEMENTS, HARDENS],
      DEVELOPER_POLLS,
      { role: "developer", tasks: ["implement", "harden"] },
    );
    assert.equal(developer.status, 0, developer.stderr);
    assert.equal(developer.ended.kind, "stopped");
    assert.deepEqual(developer.run.accounts, [
      { provider: "github", login: DEVELOPER },
    ]);
    const developed = actionsByTask(developer);
    assert.deepEqual([...developed.keys()].sort(), ["harden", "implement"]);
    const implement = actionOf(developed, "implement");
    const harden = actionOf(developed, "harden");
    // The Developer moved only the item's branch: the target is untouched.
    assert.equal(box.git(["rev-parse", "main"]), target);
    const hardened = box.git(["rev-parse", `agent/issue-${ISSUE}`]);
    const implemented = box.git(["rev-parse", `${hardened}^`]);
    assert.equal(box.git(["rev-parse", `${implemented}^`]), target);
    assert.equal(
      box.git(["log", "-1", "--format=%s", hardened]),
      HARDENS.commit?.message,
    );

    // The Gatekeeper: Integrate, Review Security, Land and Complete.
    const gatekeeper = await box.runBuddy([REVIEWS], GATEKEEPER_POLLS, {
      role: "gatekeeper",
      tasks: ["integrate", "review-security", "land", "complete"],
    });
    assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    assert.equal(gatekeeper.ended.kind, "stopped");
    assert.deepEqual(gatekeeper.run.accounts, [
      { provider: "github", login: LANDING },
    ]);
    const kept = actionsByTask(gatekeeper);
    const integrate = actionOf(kept, "integrate");
    const review = actionOf(kept, "review-security");
    const land = actionOf(kept, "land");
    const complete = actionOf(kept, "complete");
    assert.equal(
      gatekeeper.actions.length,
      developer.actions.length + GATEKEEPER_TASKS,
    );

    // Every action passed, ended and released what it held; each ran its
    // own ops, sessions and reservations, under its own buddy run.
    const shapes = [implement, harden, integrate, review, land, complete].map(
      (action) => [action.task, settledShape(action)],
    );
    assert.deepEqual(shapes, [
      ["implement", { ...PASSED_AND_RELEASED, reservations: ["released"] }],
      ["harden", { ...PASSED_AND_RELEASED, reservations: ["released"] }],
      ["integrate", { ...PASSED_AND_RELEASED, reservations: [] }],
      [
        "review-security",
        { ...PASSED_AND_RELEASED, reservations: ["released"] },
      ],
      ["land", { ...PASSED_AND_RELEASED, reservations: [] }],
      ["complete", { ...PASSED_AND_RELEASED, reservations: [] }],
    ]);
    for (const action of [implement, harden]) {
      assert.equal(action.buddyRun, developer.run.id);
      assert.equal(action.execution.lane, `buddy:hippy:${REPO}:${ISSUE}`);
    }
    for (const action of [integrate, review, land, complete]) {
      assert.equal(action.buddyRun, gatekeeper.run.id);
      assert.equal(action.execution.lane, `buddy:lawd:${REPO}:${ISSUE}`);
      assert.equal(action.authorization, land.authorization);
    }
    assert.notEqual(implement.authorization, land.authorization);
    assert.deepEqual(
      [implement, harden, integrate, review, land, complete].map((action) => [
        action.task,
        action.operations.map((item) => [item.op, item.outcome]),
        action.sessions.map((item) => [
          item.agent,
          item.phase,
          item.commits,
          item.outcome,
        ]),
      ]),
      [
        [
          "implement",
          [
            ["task-attempt", "ok"],
            ["checkpoint-action", "ok"],
            ["push", "ok"],
            ["open-task-pr", "ok"],
            ["task-result", "ok"],
          ],
          [["issue-pipeline-developer", null, true, "ok"]],
        ],
        [
          "harden",
          [
            ["task-attempt", "ok"],
            ["checkpoint-action", "ok"],
            ["push", "ok"],
            ["open-task-pr", "ok"],
            ["task-result", "ok"],
          ],
          [["issue-pipeline-developer", "hardening", true, "ok"]],
        ],
        [
          "integrate",
          [
            ["task-attempt", "ok"],
            ["integrate-task", "ok"],
            ["task-result", "ok"],
          ],
          [],
        ],
        [
          "review-security",
          [
            ["task-attempt", "ok"],
            ["task-result", "ok"],
          ],
          [["issue-pipeline-reviewer", "security-review", false, "ok"]],
        ],
        [
          "land",
          [
            ["task-attempt", "ok"],
            ["land-task", "ok"],
            ["task-result", "ok"],
          ],
          [],
        ],
        [
          "complete",
          [
            ["task-attempt", "ok"],
            ["complete-task", "ok"],
            ["task-result", "ok"],
          ],
          [],
        ],
      ],
    );

    // Three model launches, each a fresh session in its own action's
    // checkout, which release removed: none after Review Security, so
    // none after the Land.
    const launches = box.launches();
    assert.deepEqual(
      launches.map((launch) =>
        [implement, harden, review].findIndex((action) =>
          launch.cwd.endsWith(`issue-${ISSUE}-action-${action.id}`),
        ),
      ),
      [0, 1, 2],
    );
    for (const launch of launches) {
      assert.equal(fs.existsSync(launch.cwd), false);
    }
    // The project's check ran once, by Integrate, on the hardened code;
    // nothing reran it for Land or Complete.
    assert.deepEqual(box.checksRun(), [hardened]);

    // The ledger: one attempt and one passed result per task, in order,
    // each bound exactly and produced by its own action and buddy run.
    const world = box.world();
    const issue = world.issues.find((item) => item.number === ISSUE);
    assert.ok(issue !== undefined);
    const records = ledger(issue.comments);
    const order = [implement, harden, integrate, review, land, complete];
    assert.deepEqual(
      records.map((record) => [
        record.kind,
        record.binding.task,
        record.run,
        record.buddyRun,
        record.verdict,
        record.by,
      ]),
      order.flatMap((action) => [
        [
          "attempt",
          action.task,
          { id: action.id, previous: null },
          action.buddyRun,
          undefined,
          LANDING,
        ],
        [
          "result",
          action.task,
          { id: action.id, previous: null },
          action.buddyRun,
          "passed",
          LANDING,
        ],
      ]),
    );
    const implementResult = only(
      records.filter(
        (record) =>
          record.kind === "result" && record.binding.task === "implement",
      ),
      "Implement result",
    );
    const requirements = implementResult.binding.requirements ?? "";
    const workItem = { repo: REPO, number: ISSUE };
    const preTarget = { branch: "main", commit: target };
    assert.deepEqual(implementResult.binding, {
      workItem,
      task: "implement",
      target: preTarget,
      requirements,
    });
    assert.ok(requirements.startsWith("sha256:"));
    const { policy } = REVISION.parse(
      records.find((record) => record.binding.revision !== undefined)?.binding
        .revision,
    );
    const inputs = requirements.slice("sha256:".length);
    function bound(task: string, code: string): unknown {
      return {
        workItem,
        task,
        target: preTarget,
        revision: { code, inputs, policy },
      };
    }
    for (const record of records) {
      const action = order.find((item) => item.id === record.run.id);
      assert.ok(action !== undefined);
      assert.deepEqual(record.binding, action.binding);
      assert.deepEqual(record.cause, action.cause);
    }
    assert.deepEqual(harden.binding, bound("harden", implemented));
    for (const action of [integrate, review, land]) {
      assert.deepEqual(action.binding, bound(action.task, hardened));
    }
    // Complete keeps the Land's own binding: R, its policy and pre-Land T.
    assert.deepEqual(complete.binding, bound("complete", hardened));
    // Implement's cause is the human's accepted start; every later task's
    // is the authenticated result signal of an earlier passed record.
    assert.equal(implement.cause.signal, `github-label:${REPO}#${ISSUE}:300`);
    for (const action of order.slice(1)) {
      const causing = records.find(
        (record) => record.id === action.cause.recordId,
      );
      assert.ok(causing !== undefined, `${action.task}'s cause is recorded`);
      assert.equal(action.cause.signal, `result:${causing.id}`);
      assert.equal(causing.kind, "result");
      assert.equal(causing.verdict, "passed");
    }
    function resultOf(action: ActionRun): TaskRecord {
      return only(
        records.filter(
          (record) => record.kind === "result" && record.run.id === action.id,
        ),
        `${action.task} result`,
      );
    }
    assert.deepEqual(resultOf(implement).receipt, {
      summary: "Counted the widgets.",
      produced: { code: implemented },
    });
    assert.deepEqual(resultOf(harden).receipt, {
      summary: "Checked the count.",
      produced: { code: hardened },
    });
    assert.deepEqual(resultOf(integrate).receipt, {
      summary: `every check passed on ${hardened} at ${target}`,
      evidence: { checks: [{ id: "test", pass: true }], retained: null },
    });
    assert.deepEqual(resultOf(review).receipt, {
      summary: "No security finding.",
    });
    const landResult = resultOf(land);
    assert.deepEqual(landResult.receipt, {
      summary: `landed ${hardened} on main over ${target}`,
      produced: { code: hardened },
      evidence: { preTarget, policy, authorization: land.authorization },
    });
    assert.notEqual(land.authorization, policy);
    // Complete names the Land result it completed from.
    assert.deepEqual(resultOf(complete).receipt, {
      summary: `completed #${ISSUE}: ${hardened} is on main`,
      evidence: { land: landResult.id, preTarget },
    });

    // The target moved once after its creation, from T to R: the Land's
    // fast-forward.
    assert.equal(box.git(["rev-parse", "main"]), hardened);
    assert.deepEqual(
      box.git(["reflog", "show", "--format=%H", "refs/heads/main"]).split("\n"),
      [hardened, target],
    );

    // GitHub: the Developer opened the one PR, which reads merged as R;
    // the landing account closed the issue as completed, saying so.
    const [pull] = world.pulls ?? [];
    assert.ok(pull !== undefined);
    assert.equal(world.pulls?.length, 1);
    assert.deepEqual(
      [pull.head, pull.base, pull.author, pull.body],
      [`agent/issue-${ISSUE}`, "main", DEVELOPER, `Closes #${ISSUE}`],
    );
    const viewed = PR_VIEW.parse(
      box.readGitHub([
        "pr",
        "view",
        String(pull.number),
        "-R",
        REPO,
        "--json",
        "number,state,mergeCommit,headRefOid,author",
      ]),
    );
    assert.deepEqual(
      [viewed.state, viewed.mergeCommit, viewed.headRefOid],
      ["MERGED", { oid: hardened }, hardened],
    );
    assert.deepEqual(issue.closed, { by: LANDING, reason: "completed" });
    assert.deepEqual(issue.events.at(-1)?.event, "closed");
    assert.ok(
      issue.comments.some(
        (comment) =>
          comment.author === LANDING &&
          comment.body === `Landed ${hardened} on main (over ${target}).`,
      ),
    );
    const calls = box.calls();
    function by(verb: readonly string[]): string[] {
      return calls
        .filter((call) => verb.every((part, at) => call.args[at] === part))
        .map((call) => call.login);
    }
    assert.deepEqual(by(["pr", "create"]), [DEVELOPER]);
    assert.deepEqual(by(["issue", "close"]), [LANDING]);

    // Coordination: each action took and released the issue's execution;
    // the sessions their model-session slot; Land alone the target's
    // integration turn, released once it settled.
    const scopes = new Map([
      [
        `["acme/widgets","main","issue",${ISSUE},"agent/issue-${ISSUE}"]`,
        "issue",
      ],
      ['["acme/widgets","main","resource","model-session",1]', "pool"],
      ['["acme/widgets","main","integration"]', "turn"],
    ]);
    const session = [
      "issue request",
      "issue confirm",
      "pool request",
      "pool confirm",
      "pool register",
      "pool done",
      "pool release",
      "issue release",
    ];
    assert.deepEqual(
      marked(world, "coordination").map(
        (item) => `${scopes.get(item.scope ?? "") ?? item.scope} ${item.kind}`,
      ),
      [
        ...session,
        ...session,
        "issue request",
        "issue confirm",
        "issue release",
        ...session,
        "issue request",
        "issue confirm",
        "turn request",
        "turn confirm",
        "turn release",
        "issue release",
        "issue request",
        "issue confirm",
        "issue release",
      ],
    );

    // Nothing passed ran again: the idle polls left each task's one action
    // as its loop's last, and the passed bindings wait.
    assert.deepEqual(
      developer.run.loops.map((loop) => [loop.task, loop.action, loop.reason]),
      [
        ["implement", implement.id, null],
        ["harden", harden.id, "Harden passed this revision and target"],
      ],
    );
    assert.deepEqual(
      gatekeeper.run.loops.map((loop) => [loop.task, loop.action]),
      [
        ["integrate", integrate.id],
        ["review-security", review.id],
        ["land", land.id],
        ["complete", complete.id],
      ],
    );
    assert.equal(
      gatekeeper.run.loops.at(-1)?.reason,
      "complete passed this binding",
    );
  } finally {
    box.cleanup();
  }
});
