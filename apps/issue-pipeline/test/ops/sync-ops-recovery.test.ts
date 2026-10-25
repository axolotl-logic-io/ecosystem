// Text-only failures preserve history and numbered stages, not a lossy patch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "../initial-write-state-fixtures.ts";
import type { OpsFixture } from "../ops-fixtures.ts";
import { opsFixture } from "../ops-fixtures.ts";
import { recoveryEvidence } from "./sync-recovery-test-kit.ts";

const fx: OpsFixture = await opsFixture("sync-recovery");
fx.fakeGh.requireReplies();
const { sh }: OpsFixture = fx;
const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);
const RECOVERY_FAILURE = z.object({ ok: z.literal(false), error: z.string() });
const CONFLICT = z.object({
  changed: z.literal(false),
  conflict: z.literal(true),
  inRebase: z.literal(true),
  conflicts: z.array(z.string()),
  baseSha: z.string(),
});
const REPLY = z.union([RECOVERY_FAILURE, CONFLICT]);
const CASES = [
  {
    n: 34,
    op: "sync-base",
    cannotFix: false,
    reason: "synchronization cleanup refused",
  },
  {
    n: 35,
    op: "finish-sync",
    cannotFix: true,
    reason: "text remains unresolved",
  },
];

function ask(
  n: number,
  op: string,
  extra: object = {},
):
  | { ok: false; error: string }
  | {
      changed: false;
      conflict: true;
      inRebase: true;
      conflicts: string[];
      baseSha: string;
    } {
  fx.fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
  return REPLY.parse(JSON.parse(fx.ask({ op, number: n, ...extra })));
}

for (const { n, op, cannotFix, reason } of CASES) {
  test(`text-only rejection, cannot-fix ${cannotFix}, retains the exact index and self-contained history with add/add stages`, () => {
    const file = `c${n}`;
    const original = fx.startBranch(n, file, "mine");
    const baseSha = fx.advanceBase(file, "theirs");
    const kept = CONFLICT.parse(ask(n, "sync-base", { keepConflict: true }));
    assert.deepEqual(kept.conflicts, [file]);
    assert.equal(kept.baseSha, baseSha);
    assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
    const wt = fx.worktree(n);
    const index = sh(
      `git -C ${wt} rev-parse --path-format=absolute --git-path index`,
    );
    const before = fx.worktreeState(n);
    const indexBytes = fs.readFileSync(index);
    const textBytes = fs.readFileSync(path.join(wt, file));
    const reply = RECOVERY_FAILURE.parse(
      ask(n, op, { baseSha, cannotFix, reason }),
    );
    for (const fact of [
      file,
      reason,
      "commits.bundle",
      "conflict-stages.json",
      "retain the original checkout",
    ]) {
      assert.ok(reply.error.includes(fact), reply.error);
    }
    const { dir, stages, bundle, restored } = recoveryEvidence(fx.root, n);
    assert.ok(reply.error.includes(dir), reply.error);
    assert.deepEqual(
      stages.map((entry) => entry.stage),
      ["2", "3"],
    );
    assert.equal(
      stages
        .map(
          (entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.file}`,
        )
        .join("\n"),
      sh(`git -C ${wt} ls-files --unmerged`),
    );
    sh(`git -C ${restored} bundle verify ${bundle}`);
    assert.equal(sh(`git -C ${restored} cat-file -t ${original}`), "commit");
    assert.equal(sh(`git -C ${restored} cat-file -t ${before.head}`), "commit");
    assert.equal(fx.inRebase(n), true);
    assert.deepEqual(fs.readFileSync(index), indexBytes);
    assert.deepEqual(fs.readFileSync(path.join(wt, file)), textBytes);
    assert.deepEqual(fx.worktreeState(n), before);
    assert.equal(fx.originRef(`agent/issue-${n}`), original);
    assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
  });
}
