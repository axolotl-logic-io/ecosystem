// Two workers on one issue keep both sets of work. Another worker pushes
// its own commit to the issue's branch while the Implement session runs, as
// it might when two buddies disagree about who owns the issue. Every push
// only fast-forwards, so the session's checkpoint and the action's final
// push go to the action's own recovery branch instead. No commit is
// replaced, no PR is opened for the mixed branch, and the issue gets a
// plain result comment that says where the work is. Only gh (fake-gh.ts)
// and pi (fake-pi.ts) are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { PlannedSession } from "./buddy-flow-test-kit.ts";
import { HARDENING, ISSUE, machine, marked } from "./buddy-flow-test-kit.ts";

const BRANCH = `agent/issue-${ISSUE}`;
const COMMIT = {
  file: "counter.txt",
  content: "3 widgets\n",
  message: "Count the widgets",
};
const RIVAL_FIRST: PlannedSession = {
  commit: COMMIT,
  change: "rival-push",
  changeFirst: true,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};
const PUSH_REPLY = z.looseObject({
  pushed: z.string(),
  pushError: z.string().nullable(),
});
const RECOVERY_ID_LENGTH = 12;
const RECORD_BLOCK = /^<!-- agent-pipeline:task-result\n\{.*\}\n-->\n\n/u;
const RECORD_JSON = /[{}]|"verdict"/u;

test("a rival push keeps both workers' commits and the action's work goes to its recovery branch", async () => {
  const box = machine();
  try {
    const { status, actions } = await box.runBuddy([RIVAL_FIRST, HARDENING], 2);
    assert.equal(status, 0);
    const [action] = actions;
    assert.ok(action !== undefined);
    assert.equal(actions.length, 1);
    const recovery = `${BRANCH}-recovery-${action.id.replaceAll("-", "").slice(0, RECOVERY_ID_LENGTH)}`;
    // The session's checkpoint was refused on the branch and kept on the
    // recovery branch.
    const [push] = box
      .commits()
      .map((result) =>
        PUSH_REPLY.parse(JSON.parse(result.content[0]?.text ?? "null")),
      );
    assert.equal(push?.pushed, "none");
    assert.ok(push.pushError?.includes(recovery));
    // Both commits exist on the origin, each on its own branch.
    assert.equal(
      box.git(["log", "-1", "--format=%s", BRANCH]),
      "Another worker's commit",
    );
    assert.equal(
      box.git(["log", "-1", "--format=%s", recovery]),
      COMMIT.message,
    );
    // The run failed without opening a PR for the branch.
    assert.equal(action.verdict, "failed");
    assert.ok(action.reason?.includes(recovery));
    assert.deepEqual(box.world().pulls ?? [], []);
    // The result comment starts with its hidden record and then speaks
    // plainly to the reader, with no machine record in its prose.
    const comment = box
      .world()
      .issues.find((item) => item.number === ISSUE)
      ?.comments.find((item) => item.body.includes('"kind":"result"'));
    assert.ok(comment !== undefined);
    assert.match(comment.body, RECORD_BLOCK);
    const prose = comment.body.replace(RECORD_BLOCK, "");
    assert.ok(prose.startsWith("I couldn't finish Implement for this issue."));
    assert.ok(prose.includes(recovery));
    assert.doesNotMatch(prose, RECORD_JSON);
    // The attempt is bookkeeping: its comment is the hidden record alone.
    const attempt = box
      .world()
      .issues.find((item) => item.number === ISSUE)
      ?.comments.find((item) => item.body.includes('"kind":"attempt"'));
    assert.ok(attempt?.body.endsWith("\n-->"));
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
  } finally {
    box.cleanup();
  }
});
