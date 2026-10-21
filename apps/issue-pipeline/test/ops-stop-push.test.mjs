// The stop op during implement: the implementer's commits that exist only
// in the worktree reach the issue's branch on GitHub
// before the stop, and a failed push only adds a line to the stop comment
// (#283).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { bodyOf, effectNames } from "./gh-effects.mjs";
import { stopMutationReplies } from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import { everyCommentsRead, kit, v2State } from "./ops-v2-test-kit.mjs";

kit.requireGhReplies();

const { askOps, effects, reply, root, sh, worktree } = kit;

const COMMITTER = "-c user.email=a@b -c user.name=a";
const ORIGIN = `${root}/origin.git`;
// The issues: pushed, rejected by origin, and stopped at review.
const PUSHED = 60;
const REJECTED = 61;
const AT_REVIEW = 62;
const LABEL = "agent:stopped-not-doable";
const ONLY_LOCAL = "only local";
// What stopAt returns for a stop at `stage`.
/** @param {string} stage @returns {string[]} */
function stoppedAt(stage) {
  return ["not-doable", LABEL, "stopped", stage];
}

// A hook's mode: executable by everyone, writable by its owner.
const EXECUTABLE = 0o755;

// Makes origin reject every push to issue `n`'s branch from now on.
/** @param {number} n @returns {void} */
function rejectPushesTo(n) {
  const hook = path.join(ORIGIN, "hooks", "pre-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/agent/issue-${n} ]; then exit 1; fi\ndone\n`,
  );
  fs.chmodSync(hook, EXECUTABLE);
}

// Gives issue `n` a branch on origin and a worktree with one commit on top
// of it. Returns the worktree's head.
/** @param {number} n @returns {string} */
function worktreeAheadOfBranch(n) {
  sh(
    `cd ${root}/seed && git checkout -qB agent/issue-${n} integration && echo ${n} > b-${n} && git add b-${n} && git commit -qm branch && git push -q origin HEAD:refs/heads/agent/issue-${n}`,
  );
  const clone = `${root}/clones/o__r`;
  sh(`git -C ${clone} fetch -q origin`);
  sh(
    `git -C ${clone} worktree add -q -B agent/issue-${n} ${worktree(n)} origin/agent/issue-${n}`,
  );
  sh(
    `cd ${worktree(n)} && echo mine > mine && git add mine && git ${COMMITTER} commit -qm mine`,
  );
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

/** @param {string} dir @param {string} branch @returns {string} */
function headOf(dir, branch) {
  return sh(`git -C ${dir} rev-parse refs/heads/${branch}`);
}

// The parts of a stop's reply these tests read.
const STOP_REPLY = z.object({
  ok: z.literal(true),
  op: z.literal("stop"),
  code: z.string(),
  label: z.string(),
  state: z.looseObject({ stage: z.string(), stoppedStage: z.string() }),
});

// Stops issue `n` at `stage` as not doable. Returns the stop code, its label
// and the stage the state stopped at.
/** @param {number} n @param {string} stage @returns {string[]} */
function stopAt(n, stage) {
  const saved = v2State(n, { stage });
  reply([
    {
      ...everyCommentsRead(n, [kit.stateComment(n, saved)]),
      persistState: true,
    },
    historyReply(n),
    ...stopMutationReplies(n, { stateId: n, pr: null, code: "not-doable" }),
  ]);
  const { code, label, state } = STOP_REPLY.parse(
    askOps({
      op: "stop",
      number: n,
      code: "not-doable",
      reason: "the change can't be done as asked",
      state: v2State(n, { stage }),
    }),
  );
  return [code, label, state.stage, state.stoppedStage];
}

test("a stop in implement pushes the worktree's commits to the branch", () => {
  const sha = worktreeAheadOfBranch(PUSHED);
  assert.deepEqual(stopAt(PUSHED, "implement"), stoppedAt("implement"));
  assert.equal(headOf(ORIGIN, `agent/issue-${PUSHED}`), sha);
  const body = bodyOf(effects(), `comment #${PUSHED} role=coordinator`);
  assert.equal(body.includes(ONLY_LOCAL), false);
});

test("a rejected push still stops, and the comment names the local head", () => {
  const sha = worktreeAheadOfBranch(REJECTED);
  rejectPushesTo(REJECTED);
  const before = headOf(ORIGIN, `agent/issue-${REJECTED}`);
  assert.deepEqual(stopAt(REJECTED, "implement"), stoppedAt("implement"));
  assert.equal(headOf(ORIGIN, `agent/issue-${REJECTED}`), before);
  const stopped = effects();
  assert.ok(effectNames(stopped).includes(`label #${REJECTED} ${LABEL}`));
  const body = bodyOf(stopped, `comment #${REJECTED} role=coordinator`);
  assert.ok(body.includes(sha) && body.includes(ONLY_LOCAL));
});

test("a stop at review pushes nothing", () => {
  worktreeAheadOfBranch(AT_REVIEW);
  const before = headOf(ORIGIN, `agent/issue-${AT_REVIEW}`);
  assert.deepEqual(stopAt(AT_REVIEW, "review"), stoppedAt("review"));
  assert.equal(headOf(ORIGIN, `agent/issue-${AT_REVIEW}`), before);
});
