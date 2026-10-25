// Lane maintenance waits for pending setup (#170): a real claim's prune is
// deferred while any lane's setup is still pending, since prune could free
// what that setup is making, and runs once no setup is pending.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "../gh-mutation-fixtures.ts";
import { historyReply } from "../initial-write-state-fixtures.ts";
import { issueReply, LANE, LAPSED, LIVE } from "../ops-claim-test-kit.ts";
import {
  askOps,
  claimComment,
  commentsReply,
  configWith,
  reply,
  requireGhReplies,
  root,
  savedStateComment,
} from "../ops-cli-test-kit.ts";
import "../ops-v2-test-kit.ts";

requireGhReplies();
const { loadConfig, paths }: typeof import("../../src/config.ts") =
  await import("../../src/config.ts");
const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);
const OUTCOME = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
});
const ISSUE = 181;
const OTHER = 182;
const STATE_ID = 30;
const pruned = path.join(root, "claim-pruned");
const config = configWith({
  laneSlots: 2,
  commands: { test: "true", prune: `echo pruned >> '${pruned}'` },
});

function claim(
  n: number,
  existing: boolean,
): { [x: string]: unknown; ok: boolean; error?: string | undefined } {
  const saved: object[] = [];
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

test("a claim defers lane prune while another lane's setup is pending, and prunes once it isn't", () => {
  const cfg = loadConfig(config);
  const store = path.join(
    path.dirname(paths.runDir(cfg, 0)),
    "lane-slots.json",
  );
  const setup = path.join(root, "other-lane-setup");
  fs.mkdirSync(setup, { recursive: true });
  const lease = { issue: OTHER, slot: 2, checkouts: [setup] };
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(
    store,
    JSON.stringify({
      leases: [{ ...lease, pendingSetup: [setup] }],
      prunedAt: null,
    }),
  );
  const first = claim(ISSUE, false);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fs.existsSync(pruned), false);
  const saved = JSON.parse(fs.readFileSync(store, "utf8"));
  assert.equal(saved.prunedAt, null);
  const other = saved.leases.find(
    ({ issue }: { issue: number }) => issue === OTHER,
  );
  assert.deepEqual(other.pendingSetup, [setup]);
  other.pendingSetup = [];
  fs.writeFileSync(store, JSON.stringify(saved));
  const again = claim(ISSUE, true);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(fs.readFileSync(pruned, "utf8"), "pruned\n");
});
