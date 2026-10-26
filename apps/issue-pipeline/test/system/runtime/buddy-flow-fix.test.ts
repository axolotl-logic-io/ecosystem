// Fix answers a PR head that didn't pass review (`fix-answers-reviews`):
// after a real Implement, Verify's request for changes, a person's, or
// Land's conflict with a moved base wakes the Developer's Fix, which merges
// the base into the PR's head, never rebasing it, answers every blocking
// comment with a commit and a reply in its thread, pushes through the
// development account and marks a draft PR ready. After three Fix rounds of
// Verify's own, a further request for changes holds for a person
// (`review-loop-limit`). Built buddy/ops, Git and ledger are real; only
// GitHub and the model fake. A person's review reaches Fix as the signal
// inbox's review signal (src/signals/inbox.ts).
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { LANDING } from "../../support/signals/signal-test-kit.ts";
import {
  advanceTarget,
  BRANCH,
  implemented,
  landFindsConflict,
  recordRun,
  results,
  review,
  revisionBinding,
  verifyRequestsChanges,
} from "./buddy-flow-review-test-kit.ts";
import type {
  BuddyChoice,
  Machine,
  PlannedSession,
} from "./buddy-flow-test-kit.ts";
import { DEVELOPER, HUMAN, machine } from "./buddy-flow-test-kit.ts";

const FIXER: BuddyChoice = { role: "developer", tasks: ["fix"] };
const FIX_POLLS = 2;
const FIX_PAGE = "# Pipeline prompt: Developer Fix";
const BLOCKING = "Count with a number, not words.";
const NIT = "Nit: end the line with a period.";
const ANSWER = "The count is now the number 3.";
const REPLY_MARK = /<!-- issue-pipeline:fix-reply run=[0-9a-f-]{36} -->/u;
const SPENT = /after 3 Fix rounds/u;
const ROUNDS = 3;
const SHA_HEX = 40;

function fixes(answer: { comment: number; reply: string }[]): PlannedSession {
  return {
    commit: {
      file: "counter.txt",
      content: "3 widgets\n",
      message: "Count with a number",
    },
    change: null,
    changeFirst: false,
    awaitAbort: false,
    reply: {
      outcome: "done",
      summary: "Counted with a number.",
      replies: answer,
    },
  };
}

// The value pi was launched with for `flag`.
function flagOf(args: readonly string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? "";
}

function parents(box: Machine, commit: string): string[] {
  return box.git(["log", "-1", "--format=%P", commit]).split(" ");
}

function keep(box: Machine, passed: boolean): void {
  if (passed) {
    box.cleanup();
    return;
  }
  process.stderr.write(`Fix flow machine kept at ${box.root}\n`);
}

test("Fix merges the moved base, answers each blocking comment and replies in its thread", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = advanceTarget(box, "upstream.txt", "upstream change\n");
    const verify = verifyRequestsChanges(box, item, {
      target,
      body: "The count must be a number.",
      comments: [
        { path: "counter.txt", line: 1, body: BLOCKING },
        { path: "counter.txt", line: 1, body: NIT },
      ],
    });
    const [blocking, nit] = verify.threads;
    assert.ok(blocking !== undefined && nit !== undefined);
    const run = await box.runBuddy(
      [fixes([{ comment: blocking, reply: ANSWER }])],
      FIX_POLLS,
      FIXER,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.find((action) => action.task === "fix");
    assert.ok(fix !== undefined);
    assert.equal(fix.verdict, "passed", fix.reason ?? "");
    assert.deepEqual(fix.cause, {
      signal: `result:${String(verify.result)}`,
      recordId: verify.result,
    });
    assert.ok("revision" in fix.binding);
    assert.equal(fix.binding.revision.code, item.head);
    assert.equal(fix.binding.target.commit, target);
    // One Developer session, phase fix, given the blocking comment and not
    // the nit.
    assert.deepEqual(
      fix.sessions.map((session) => [session.phase, session.commits]),
      [["fix", true]],
    );
    const launch = box.launches().at(-1);
    assert.ok(launch !== undefined);
    assert.ok(
      flagOf(launch.args, "--append-system-prompt").startsWith(FIX_PAGE),
    );
    assert.ok(launch.prompt.includes(`Comment ${String(blocking)}`));
    assert.ok(launch.prompt.includes(BLOCKING));
    assert.equal(launch.prompt.includes(NIT), false);
    // The new head is the session's commit on a merge of the base into the
    // reviewed head, which keeps its identity.
    const head = box.git(["rev-parse", BRANCH]);
    const [merge] = parents(box, head);
    assert.ok(merge !== undefined);
    assert.deepEqual(parents(box, merge), [item.head, target]);
    assert.equal(box.git(["show", `${head}:counter.txt`]), "3 widgets");
    assert.equal(box.git(["show", `${head}:upstream.txt`]), "upstream change");
    assert.equal(box.git(["rev-parse", "main"]), target);
    // The development account replied in the blocking thread alone.
    const comments = box.world().pulls?.[0]?.reviewComments ?? [];
    const replies = comments.filter((comment) => comment.inReplyTo !== null);
    assert.deepEqual(
      replies.map((reply) => [reply.inReplyTo, reply.author]),
      [[blocking, DEVELOPER]],
    );
    assert.ok(replies[0]?.body.startsWith(ANSWER));
    assert.match(replies[0]?.body ?? "", REPLY_MARK);
    // The landing account recorded the pass, naming the pushed head.
    const result = results(box).find((entry) => entry.binding.task === "fix");
    assert.ok(result !== undefined);
    assert.equal(result.verdict, "passed");
    assert.equal(result.receipt.produced?.code, head);
    assert.deepEqual(result.receipt.evidence, {
      pr: item.pr,
      base: target,
      replies: [blocking],
    });
    // Nothing woke Fix for the new head: a new activation does nothing.
    const launches = box.launches().length;
    const again = await box.runBuddy([], FIX_POLLS, FIXER, signal);
    assert.equal(again.status, 0);
    assert.equal(
      again.actions.filter((action) => action.task === "fix").length,
      1,
    );
    assert.equal(box.launches().length, launches);
    assert.equal(box.git(["rev-parse", BRANCH]), head);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("Fix resolves a Land conflict in its session, concludes the merge and marks the draft PR ready", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = advanceTarget(box, "counter.txt", "four widgets\n");
    const land = landFindsConflict(box, item, { target, cause: item.result });
    const resolves: PlannedSession = {
      commit: null,
      resolve: { file: "counter.txt", content: "four widgets, counted\n" },
      change: null,
      changeFirst: false,
      awaitAbort: false,
      reply: { outcome: "done", summary: "Kept both counts.", replies: [] },
    };
    const run = await box.runBuddy([resolves], FIX_POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.find((action) => action.task === "fix");
    assert.ok(fix !== undefined);
    assert.equal(fix.verdict, "passed", fix.reason ?? "");
    assert.equal(fix.cause.signal, `result:${String(land)}`);
    // The session was told which file the stopped merge left.
    assert.ok(box.launches().at(-1)?.prompt.includes("`counter.txt`"));
    // Fix concluded the merge the session resolved: a merge commit of the
    // reviewed head and the base, with the resolution.
    const head = box.git(["rev-parse", BRANCH]);
    assert.deepEqual(parents(box, head), [item.head, target]);
    assert.equal(
      box.git(["show", `${head}:counter.txt`]),
      "four widgets, counted",
    );
    const pull = box.world().pulls?.[0];
    assert.equal(pull?.isDraft, false);
    assert.deepEqual(pull?.reviewComments ?? [], []);
    const result = results(box).find((entry) => entry.binding.task === "fix");
    assert.equal(result?.receipt.produced?.code, head);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("a person's request for changes on the head wakes Fix", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const person = review(box, {
      pr: item.pr,
      head: item.head,
      author: HUMAN,
      state: "CHANGES_REQUESTED",
      body: "",
      comments: [{ path: "counter.txt", line: 1, body: BLOCKING }],
    });
    const [thread] = person.threads;
    assert.ok(thread !== undefined);
    const run = await box.runBuddy(
      [fixes([{ comment: thread, reply: ANSWER }])],
      FIX_POLLS,
      FIXER,
      signal,
    );
    assert.equal(run.status, 0, run.stderr);
    const fix = run.actions.find((action) => action.task === "fix");
    assert.ok(fix !== undefined, JSON.stringify(run.run.loops));
    assert.equal(fix.verdict, "passed", fix.reason ?? "");
    assert.equal(fix.cause.signal.startsWith("result:"), false);
    // No base moved, so the session's commit sits on the reviewed head.
    const head = box.git(["rev-parse", BRANCH]);
    assert.deepEqual(parents(box, head), [item.head]);
    const replies = (box.world().pulls?.[0]?.reviewComments ?? []).filter(
      (comment) => comment.inReplyTo === thread,
    );
    assert.equal(replies.length, 1);
    passed = true;
  } finally {
    keep(box, passed);
  }
});

test("after three Fix rounds of Verify's own, a further request for changes holds for a person", async ({
  signal,
}) => {
  const box = machine();
  let passed = false;
  try {
    const item = await implemented(box, signal);
    const target = box.git(["rev-parse", "main"]);
    // Three earlier rounds on earlier heads: each a refused Verify, then
    // the Fix it caused.
    for (let round = 1; round <= ROUNDS; round += 1) {
      const earlier = String(round).repeat(SHA_HEX);
      const refused = recordRun(box, {
        binding: revisionBinding(box, "verify", earlier, target),
        cause: item.result,
        verdict: "refused",
        receipt: { summary: "Verify requested changes" },
      });
      recordRun(box, {
        binding: revisionBinding(box, "fix", earlier, target),
        cause: refused,
        verdict: "passed",
        receipt: { summary: "answered", produced: { code: item.head } },
      });
    }
    verifyRequestsChanges(box, item, {
      target,
      body: "Still words.",
      comments: [{ path: "counter.txt", line: 1, body: BLOCKING }],
    });
    const run = await box.runBuddy([], FIX_POLLS, FIXER, signal);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      run.actions.filter((action) => action.task === "fix"),
      [],
    );
    const loop = run.run.loops.find((entry) => entry.task === "fix");
    assert.equal(loop?.state, "held");
    assert.match(loop?.reason ?? "", SPENT);
    assert.equal(box.git(["rev-parse", BRANCH]), item.head);
    assert.equal(
      box
        .world()
        .pulls?.[0]?.reviewComments?.some(
          (comment) => comment.author !== LANDING,
        ),
      false,
    );
    passed = true;
  } finally {
    keep(box, passed);
  }
});
