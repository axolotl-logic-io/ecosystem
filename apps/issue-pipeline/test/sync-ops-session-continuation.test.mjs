// @ts-check
// Regression: a resolver continued code itself, reaching a later gitlink pick.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  ask,
  fx,
  recoveryEvidence,
  resolveText,
  seed,
  sessionStop,
  sh,
  stagePin,
  unmerged,
  wikiCommit,
} from "./session-sync-test-kit.mjs";
import { pinAt } from "./wiki-pin-test-kit.mjs";

const ISSUE = { resolved: 81, mixed: 83, rejected: 84, abort: 86 };
for (const cannotFix of [false, true]) {
  test(`session continued to wiki-only, cannot-fix ${cannotFix}: finish handles every later pick against the recorded target`, () => {
    const n = ISSUE.resolved + Number(cannotFix);
    const w = sessionStop(n);
    assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
    stagePin(seed, wikiCommit(`moved${n}`));
    fx.advanceBase(`moving${n}`, "newer base");
    sh(`git -C ${w.wt} fetch -q origin integration`);
    const reply = ask(n, "finish-sync", { baseSha: w.base, cannotFix });
    assert.equal(reply.resolved, true, reply.reason ?? reply.error);
    assert.equal(fx.inRebase(n), false);
    assert.equal(unmerged(w.wt), "");
    assert.equal(pinAt(w.wt, "HEAD"), w.target);
    assert.equal(
      pinAt(path.join(fx.root, "origin.git"), `agent/issue-${n}`),
      w.target,
    );
    assert.equal(fs.existsSync(path.join(w.wt, "wiki", ".git")), false);
  });
}

test("a session's later mixed stop exposes only text, and records deterministic resolution before handoff", () => {
  const w = sessionStop(ISSUE.mixed, true);
  assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
  const reply = ask(w.n, "finish-sync", { baseSha: w.base });
  assert.deepEqual(reply.conflicts, ["later83"]);
  assert.equal(sh(`git -C ${w.wt} rev-parse :wiki`), w.target);
  const metadata = sh(
    `git -C ${w.wt} rev-parse --git-path pipeline-code-sync.json`,
  );
  assert.equal(
    z
      .object({ wikiResolved: z.boolean() })
      .parse(JSON.parse(fs.readFileSync(path.resolve(w.wt, metadata), "utf8")))
      .wikiResolved,
    true,
  );
  resolveText(w.wt, "later83");
  const finished = ask(w.n, "finish-sync", { baseSha: w.base });
  assert.equal(finished.resolved, true, finished.reason ?? finished.error);
  assert.equal(pinAt(w.wt, "HEAD"), w.target);
});

for (const abort of [false, true]) {
  test(`later mixed stop with abort ${abort} saves a verified bundle and full stages, retaining exact unresolved work`, () => {
    const w = sessionStop(ISSUE.rejected + Number(abort), true);
    assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
    const head = sh(`git -C ${w.wt} rev-parse HEAD`);
    const text = fs.readFileSync(path.join(w.wt, `later${w.n}`));
    fs.writeFileSync(path.join(w.wt, "notes.txt"), "partial resolver notes\n");
    const reply = ask(w.n, "finish-sync", {
      baseSha: w.base,
      abort,
      cannotFix: !abort,
      reason: "resolver gave up",
    });
    assert.equal(reply.ok, false);
    assert.ok(reply.error?.includes("resolver gave up"), reply.error);
    assert.ok(reply.error?.includes(`later${w.n}`), reply.error);
    assert.ok(reply.error?.includes("conflict-stages.json"), reply.error);
    assert.ok(reply.error?.includes("commits.bundle"), reply.error);
    assert.equal(sh(`git -C ${w.wt} rev-parse :wiki`), w.target);
    assert.equal(fx.inRebase(w.n), true);
    assert.equal(sh(`git -C ${w.wt} rev-parse HEAD`), head);
    assert.deepEqual(fs.readFileSync(path.join(w.wt, `later${w.n}`)), text);
    assert.equal(
      fs.readFileSync(path.join(w.wt, "notes.txt"), "utf8"),
      "partial resolver notes\n",
    );
    assert.equal(fx.originRef(`agent/issue-${w.n}`), w.original);
    const { stages, bundle, restored } = recoveryEvidence(w.n);
    assert.deepEqual(
      stages
        .map(
          (entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.file}`,
        )
        .join("\n"),
      unmerged(w.wt),
    );
    assert.deepEqual(
      stages.map((entry) => entry.stage),
      ["1", "2", "3"],
    );
    sh(`git -C ${restored} bundle verify ${bundle}`);
    assert.equal(sh(`git -C ${restored} cat-file -t ${head}`), "commit");
    assert.equal(sh(`git -C ${restored} cat-file -t ${w.original}`), "commit");
  });
}

test("an explicit abort classifies a later wiki-only stop but never pushes it", () => {
  const w = sessionStop(ISSUE.abort);
  assert.deepEqual(w.stop, [[`early${w.n}`], 1, true, true]);
  const reply = ask(w.n, "finish-sync", {
    baseSha: w.base,
    abort: true,
    reason: "explicit rejection",
  });
  assert.equal(reply.resolved, false);
  assert.equal(reply.reason, "explicit rejection");
  assert.equal(fx.inRebase(w.n), false);
  assert.equal(unmerged(w.wt), "");
  assert.equal(fx.originRef(`agent/issue-${w.n}`), w.original);
  assert.equal(sh(`git -C ${w.wt} rev-parse HEAD`), w.original);
});
