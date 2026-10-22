// @ts-check
// The save-state op through the ops CLI on version 2 states: it writes the
// state it is given, refuses a request without one, and keeps the code merge
// the issue has saved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectNames, stateOf } from "../gh-effects-test-kit.mjs";
import { commentWriteReplies } from "../gh-mutation-fixtures.mjs";
import { kit, v2State } from "../ops-v2-test-kit.mjs";

kit.requireGhReplies();
const { askOps, commentsReply, effects, reply, stateComment, writes } = kit;

const SAVED = { n: 50, state: 12 };
const SAVED_MERGE = { n: 57, state: 13, pr: 9 };
const SAVE_REPLY = { ok: true, op: "save-state", posted: 0, commentIds: [] };
const BAD_SAVE = /bad save-state request/u;
const SHA_LENGTH = 40;
const CODE_MERGED = { pr: SAVED_MERGE.pr, sha: "b".repeat(SHA_LENGTH) };

test("save-state writes the state it is given, and refuses a request without one", () => {
  const { n, state: stateId } = SAVED;
  const state = v2State(n, { stage: "review" });
  reply([
    { ...commentsReply(n, [stateComment(stateId, v2State(n))]), keep: true },
    ...commentWriteReplies("o/r", n, [stateId]),
  ]);
  assert.deepEqual(askOps({ op: "save-state", number: n, state }), SAVE_REPLY);
  const saved = effects();
  assert.deepEqual(effectNames(saved), [`edit comment ${stateId} state`]);
  assert.deepEqual(stateOf(saved, `edit comment ${stateId} state`), state);
  reply([]);
  const refused = askOps({ op: "save-state", number: n });
  assert.partialDeepStrictEqual(refused, { ok: false });
  assert.match(String(Reflect.get(new Object(refused), "error")), BAD_SAVE);
  assert.deepEqual(writes(), []);
});

// Only the claim records the code merge, from GitHub
// (ops-claim-provenance.test.mjs): a state write neither sets nor clears it.
test("save-state keeps the saved code merge, whatever the state it is given says", () => {
  const { n, state: stateId } = SAVED_MERGE;
  const forged = v2State(n, { stage: "merge", codeMerged: CODE_MERGED });
  reply([
    { ...commentsReply(n, [stateComment(stateId, v2State(n))]), keep: true },
    ...commentWriteReplies("o/r", n, [stateId]),
  ]);
  askOps({ op: "save-state", number: n, state: forged });
  const unmerged = effects();
  const written = stateOf(unmerged, `edit comment ${stateId} state`);
  assert.deepEqual(written, { ...forged, codeMerged: null });
  const saved = stateComment(stateId, forged);
  reply([
    { ...commentsReply(n, [saved]), keep: true },
    ...commentWriteReplies("o/r", n, [stateId]),
  ]);
  const cleared = { ...forged, codeMerged: null };
  askOps({ op: "save-state", number: n, state: cleared });
  const kept = stateOf(effects(), `edit comment ${stateId} state`);
  assert.deepEqual(kept, forged);
});
