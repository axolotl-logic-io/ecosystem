// @ts-check
// A reauthor checkpoint cannot replace invalid existing authority with display defaults.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { commentLines } from "../fake-gh.mjs";
import {
  collaboratorReply,
  commentWriteReplies,
} from "../gh-mutation-fixtures.mjs";
import {
  fakeGh,
  ghIsRead,
  openWith,
  recordedSpawns,
  resetRuns,
  STATE_ID_BASE,
  stateComment,
  tickOver,
} from "./orchestrator-world-test-kit.mjs";
import { git, heldCheckout } from "./orchestrator-write-authority-test-kit.mjs";

fakeGh.requireReplies();
const { newIssueState } = await import("../../src/state.ts");
const FIRST_ISSUE = 10;
const REFUSED =
  /has no saved write authority|saved write authority is invalid/u;
beforeEach(resetRuns);

for (const [index, invalid] of [
  null,
  { version: 3 },
  { pr: "bad" },
  { security: {} },
  { codeMerged: {} },
  { merged: {} },
  { hardened: {} },
  { integration: {} },
  { gherkin: {} },
].entries()) {
  test(`fresh reauthor authority ${JSON.stringify(invalid)} refuses checkpoint, labels, code writes and spawn`, () => {
    const number = FIRST_ISSUE + index;
    const {
      wt,
      origin,
      local,
      index: originalIndex,
      before,
      refs,
    } = heldCheckout(number);
    const complete = { ...newIssueState(number), stage: "implement" };
    let fresh = "";
    if (invalid !== null) {
      fresh = commentLines([
        stateComment(number, complete),
        {
          ...stateComment(number, { ...complete, ...invalid }),
          id: STATE_ID_BASE + STATE_ID_BASE + number,
          ...Object.fromEntries([
            ["node_id", `comment-${STATE_ID_BASE + STATE_ID_BASE + number}`],
          ]),
        },
      ]);
    }
    const when = `issues/${number}/comments?per_page`;
    openWith(
      [{ number, state: complete }],
      [
        { when, stdout: commentLines([stateComment(number, complete)]) },
        { when, stdout: fresh, keep: true },
        collaboratorReply("o/r", "alice"),
        ...commentWriteReplies("o/r", number, [STATE_ID_BASE + number]),
      ],
    );
    assert.throws(() => tickOver(), REFUSED);
    assert.deepEqual(fakeGh.writes(ghIsRead), []);
    assert.deepEqual(recordedSpawns, []);
    assert.equal(git(["-C", origin, "show-ref"]), refs);
    assert.equal(git(["-C", wt, "rev-parse", "HEAD"]), local);
    assert.deepEqual(fs.readFileSync(originalIndex), before);
    assert.equal(
      fs.readFileSync(path.join(wt, "held.txt"), "utf8"),
      "staged\nunstaged\n",
    );
    assert.equal(
      fs.readFileSync(path.join(wt, "dirty.txt"), "utf8"),
      "untracked bytes\n",
    );
  });
}
