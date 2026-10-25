// @ts-check
// Capacity is checked before a real claim's GitHub mutations or setup.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { issueReply, LANE, LAPSED, LIVE } from "../ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  configWith,
  reply,
  requireGhReplies,
  root,
  savedStateComment,
  worktree,
  writes,
} from "../ops-cli-test-kit.mjs";
import "../ops-v2-test-kit.mjs";

requireGhReplies();
const { loadConfig } = await import("../../src/config.ts");
const { removeWorktree } = await import("../../src/checkouts.ts");
const { newIssueState } = await import("../../src/state.ts");
const OUTCOME = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
});
const FIRST = 181;
const NEXT = 182;
const STATE_ID = 30;
const marker = path.join(root, "claimed-setup");
const pruned = path.join(root, "claim-pruned");
const config = configWith({
  laneSlots: 1,
  commands: {
    test: "true",
    setup: `printf '%s:%s\\n' "$PWD" "$ISSUE_PIPELINE_LANE_SLOT" >> '${marker}'`,
    prune: `printf '%s:%s\\n' "$PWD" "$ISSUE_PIPELINE_LANE_SLOTS" >> '${pruned}'; exit 3`,
  },
});

/** @param {number} n @param {boolean} [existing] */
function claim(n, existing = false) {
  const saved = [];
  if (existing) {
    saved.push(savedStateComment(STATE_ID, newIssueState(n)));
    saved.push(claimComment(n * 10 - 1, "expired-holder", "old", LAPSED));
  }
  const mine = claimComment(n * 10, "me", "s1", LIVE);
  reply([
    historyReply(n, []),
    issueReply(n),
    commentsReply(n, saved),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(n, [...saved, mine]),
    commentsReply(n, [...saved, mine]),
    ...claimMutationReplies(n, STATE_ID, null),
  ]);
  return OUTCOME.parse(askOps({ op: "claim", config, number: n, ...LANE }));
}

const NO_SLOT_RETRY = /no free lane slot.*retry/u;
test("claim retains its slot across reclaim, refuses exhaustion without half a claim, and frees it only on removal", () => {
  const first = claim(FIRST);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(
    fs.readFileSync(marker, "utf8"),
    `${fs.realpathSync(worktree(FIRST))}:1\n`,
  );
  // A failing prune is nonfatal and runs from the metadata clone, not the issue.
  assert.equal(
    fs.readFileSync(pruned, "utf8"),
    `${fs.realpathSync(path.join(root, "clones/o__r"))}:1\n`,
  );
  assert.equal(claim(FIRST, true).ok, true);
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 2);
  const exhausted = claim(NEXT);
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.error ?? "", NO_SLOT_RETRY);
  assert.deepEqual(writes(), []);
  assert.equal(fs.existsSync(worktree(NEXT)), false);
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 2);
  removeWorktree(loadConfig(config), FIRST);
  assert.equal(fs.existsSync(worktree(FIRST)), false);
  const next = claim(NEXT);
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(
    fs.readFileSync(marker, "utf8").trim().split("\n").at(-1),
    `${fs.realpathSync(worktree(NEXT))}:1`,
  );
  assert.equal(fs.readFileSync(pruned, "utf8").trim().split("\n").length, 1);
});
