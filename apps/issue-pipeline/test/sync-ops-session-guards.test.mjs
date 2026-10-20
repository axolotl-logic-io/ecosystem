// @ts-check
// Later session-owned stops retain the exact synchronization provenance guards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  ask,
  fx,
  sessionStop,
  sh,
  unmerged,
} from "./session-sync-test-kit.mjs";

const ISSUE = { source: 91, target: 92, disabled: 93 };
const SYNC = z.object({
  from: z.string(),
  onto: z.string(),
  wikiResolved: z.boolean(),
});

test("a later deterministic resolution cannot bypass the saved source check", () => {
  const w = sessionStop(ISSUE.source);
  assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
  const file = path.resolve(
    w.wt,
    sh(`git -C ${w.wt} rev-parse --git-path pipeline-code-sync.json`),
  );
  const sync = SYNC.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(file, JSON.stringify({ ...sync, from: w.base }));
  const reply = ask(w.n, "finish-sync", { baseSha: w.base, cannotFix: true });
  assert.equal(reply.resolved, false);
  assert.ok(
    reply.reason?.includes(
      "does not match the synchronization source and target",
    ),
    reply.reason,
  );
  assert.equal(fx.originRef(`agent/issue-${w.n}`), w.original);
});

test("a later stop rejects a different requested target without changing the unresolved index", () => {
  const w = sessionStop(ISSUE.target);
  assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
  const stages = unmerged(w.wt);
  const reply = ask(w.n, "finish-sync", {
    baseSha: w.original,
    cannotFix: true,
  });
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes("target differs"), reply.error);
  assert.equal(unmerged(w.wt), stages);
  assert.equal(fx.originRef(`agent/issue-${w.n}`), w.original);
});

test("abort with disabled wiki flow retains a later gitlink stop and reports all full numbered stages", () => {
  const w = sessionStop(ISSUE.disabled);
  assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
  const stages = unmerged(w.wt);
  const disabled = fx.configWith("disabled-finish.json", { wiki: false });
  const reply = ask(
    w.n,
    "finish-sync",
    { baseSha: w.base, abort: true },
    disabled,
  );
  assert.equal(reply.ok, false);
  assert.ok(reply.error?.includes('"wiki"'), reply.error);
  for (const line of stages.split("\n")) {
    const [mode, sha, numbered] = line.split(" ");
    const stage = numbered?.split("\t")[0];
    assert.ok(
      reply.error?.includes(`stage ${stage}: ${sha} (mode ${mode})`),
      reply.error,
    );
  }
  assert.equal(unmerged(w.wt), stages);
  assert.equal(fx.inRebase(w.n), true);
  assert.equal(fx.originRef(`agent/issue-${w.n}`), w.original);
});
