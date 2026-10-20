// @ts-check
// Real integration and ops traverse one rebase; only final checked work is pushed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  fixture,
  history,
  resolveHistory,
  syncContext,
} from "./alternating-sync-test-kit.mjs";
import { recoveryEvidence } from "./sync-recovery-test-kit.mjs";
import { pinAt } from "./wiki-pin-test-kit.mjs";

const { fx, ask, resolveText, unmerged } = fixture;
const { saveCodeSync } = await import("../src/rebase.ts");
const ISSUE = {
  alternating: 101,
  wikiFirst: 102,
  mixed: 103,
  textFirst: 104,
  limit: 105,
  last: 106,
  wikiOnly: 107,
};
const CUMULATIVE = { initial: 2, next: 3, max: 4 };
/** @typedef {import("./alternating-sync-test-kit.mjs").History} History */
/** @typedef {import("./alternating-sync-test-kit.mjs").SyncRun} SyncRun */
/** @type {{ name: string; n: number; picks: ("text" | "wiki" | "mixed")[]; counts: number[]; initial: number; max: number }[]} */
const CASES = [
  {
    name: "text then wiki then text uses two sessions on the same rebase",
    n: ISSUE.alternating,
    picks: ["text", "wiki", "text"],
    counts: [1, 2],
    initial: 0,
    max: 2,
  },
  {
    name: "wiki then text reaches one resolver without consuming a gitlink attempt",
    n: ISSUE.wikiFirst,
    picks: ["wiki", "text"],
    counts: [1],
    initial: 0,
    max: 1,
  },
  {
    name: "a mixed pick resolves wiki first and later text uses the cumulative allowance",
    n: ISSUE.mixed,
    picks: ["mixed", "text"],
    counts: [CUMULATIVE.next, CUMULATIVE.max],
    initial: CUMULATIVE.initial,
    max: CUMULATIVE.max,
  },
  {
    name: "the last permitted text resolution can finish through multiple gitlink picks",
    n: ISSUE.last,
    picks: ["text", "wiki", "wiki"],
    counts: [1],
    initial: 0,
    max: 1,
  },
  {
    name: "an already exhausted allowance still permits a gitlink-only rebase",
    n: ISSUE.wikiOnly,
    picks: ["wiki", "wiki"],
    counts: [],
    initial: 0,
    max: 0,
  },
];

/** @param {History} h @param {SyncRun} run */
function resultFacts(h, run) {
  return {
    count: run.end.ok && run.end.value.counts.conflictFixes,
    counts: run.saves.map((state) => state.counts.conflictFixes),
    rebasing: fx.inRebase(h.n),
    unmerged: unmerged(h.wt),
    pin: pinAt(h.wt, "HEAD"),
    pushedPin: pinAt(path.join(fx.root, "origin.git"), `agent/issue-${h.n}`),
    head: fx.sh(`git -C ${h.wt} rev-parse HEAD`),
    remote: fx.originRef(`agent/issue-${h.n}`),
    submodule: fs.existsSync(path.join(h.wt, "wiki", ".git")),
  };
}

for (const scenario of CASES) {
  test(`${scenario.name}`, async () => {
    const h = history(scenario.n, scenario.picks);
    const run = await resolveHistory(h, scenario.max, {
      initial: scenario.initial,
    });
    assert.ok(run.end.ok);
    const facts = resultFacts(h, run);
    assert.deepEqual(facts, {
      count: scenario.counts.at(-1) ?? 0,
      counts: scenario.counts,
      rebasing: false,
      unmerged: "",
      pin: h.target,
      pushedPin: h.target,
      head: facts.remote,
      remote: facts.remote,
      submodule: false,
    });
    assert.equal(run.ops.filter((op) => op.name === "sync-base").length, 1);
    const finishes = run.ops.filter((op) => op.name === "finish-sync");
    assert.equal(finishes.length, scenario.counts.length);
    assert.deepEqual(
      finishes.map((op) => op.saved),
      scenario.counts,
    );
    assert.deepEqual(
      finishes.map((op) => op.attempts),
      scenario.counts,
    );
    assert.deepEqual(
      run.ops.map((op) => op.remote),
      run.ops.map(() => h.original),
    );
    assert.equal(run.sessions.length, scenario.counts.length);
    for (const [index, { spec, files }] of run.sessions.entries()) {
      assert.equal(spec.phase, "integration");
      assert.equal(spec.agent, "issue-pipeline-reviewer");
      assert.ok(spec.task.includes(`at \`${h.base}\``));
      assert.ok(
        spec.task.includes(
          `Attempt: ${scenario.counts[index]} of ${scenario.max}`,
        ),
      );
      assert.equal(spec.task.includes("last resolution was rejected"), false);
      assert.equal(spec.task.includes("- wiki"), false);
      assert.ok(files.length > 0);
      for (const file of files) {
        assert.ok(spec.task.includes(`- ${file}`));
      }
    }
    assert.equal(new Set(run.stoppedPicks).size, scenario.counts.length);
  });
}

test("staged text at a mixed pick can precede deterministic wiki resolution without session continuation", async () => {
  const h = history(ISSUE.textFirst, ["mixed", "text"]);
  // Production start normally classifies wiki first. Prepare a raw mixed stop
  // to show finish also handles a resolver staging text before classification.
  fx.sh(`git -C ${h.wt} fetch -q origin integration`);
  saveCodeSync(h.wt, { from: h.original, onto: h.base, wikiResolved: false });
  const stopped = spawnSync("git", ["-C", h.wt, "rebase", h.base], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(stopped.status, 1);
  assert.ok(unmerged(h.wt).includes("\twiki"));
  const run = await resolveHistory(h, 2, {
    first: {
      conflict: true,
      inRebase: true,
      conflicts: ["text104-0"],
      baseSha: h.base,
    },
  });
  const facts = resultFacts(h, run);
  assert.deepEqual(facts, {
    count: 2,
    counts: [1, 2],
    rebasing: false,
    unmerged: "",
    pin: h.target,
    pushedPin: h.target,
    head: facts.remote,
    remote: facts.remote,
    submodule: false,
  });
  assert.equal(run.sessions.length, 2);
  assert.equal(run.ops.filter((op) => op.name === "sync-base").length, 0);
  assert.deepEqual(
    run.ops.map((op) => op.saved),
    [1, 2],
  );
});

/** @param {History} h */
function retainedState(h) {
  const indexFile = path.resolve(
    h.wt,
    fx.sh(`git -C ${h.wt} rev-parse --git-path index`),
  );
  return {
    state: fx.worktreeState(h.n),
    index: fs.readFileSync(indexFile),
    text: fs.readFileSync(path.join(h.wt, "text105-2")),
    notes: fs.readFileSync(path.join(h.wt, "notes.txt")),
    context: syncContext(h.wt),
    rebasing: fx.inRebase(h.n),
    remote: fx.originRef(`agent/issue-${h.n}`),
  };
}

function laterTextStop() {
  const h = history(ISSUE.limit, ["text", "wiki", "text"]);
  const first = ask(h.n, "sync-base");
  resolveText(h.wt, "text105-0");
  const later = ask(h.n, "finish-sync", { baseSha: h.base });
  fs.writeFileSync(path.join(h.wt, "notes.txt"), "partial recovery notes\n");
  const before = retainedState(h);
  return { h, first, later, before };
}

test("exhaustion at a later text pick is a conflict-control stop with exact retained recovery evidence", async () => {
  const { h, first, later, before } = laterTextStop();
  assert.deepEqual(first.conflicts, ["text105-0"]);
  assert.deepEqual(later.conflicts, ["text105-2"]);
  const run = await resolveHistory(h, 1, {
    initial: 1,
    first: {
      conflict: true,
      inRebase: true,
      conflicts: ["text105-2"],
      baseSha: h.base,
    },
  });
  assert.equal(run.sessions.length, 0);
  assert.equal(run.saves.length, 0);
  assert.ok(!run.end.ok && run.end.end.kind === "stop");
  const { code, reason, state } = run.end.end;
  assert.equal(code, "conflict");
  assert.equal(state.counts.conflictFixes, 1);
  for (const fact of [
    "maxConflictFixes",
    "1 attempts",
    h.original,
    "text105-2",
    "commits.bundle",
    "conflict-stages.json",
  ]) {
    assert.ok(reason.includes(fact), reason);
  }
  const { dir, stages, bundle, restored } = recoveryEvidence(fx.root, h.n);
  assert.ok(reason.includes(dir));
  assert.deepEqual(
    stages.map((entry) => entry.stage),
    ["1", "2", "3"],
  );
  assert.equal(
    stages
      .map(
        (entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.file}`,
      )
      .join("\n"),
    unmerged(h.wt),
  );
  fx.sh(`git -C ${restored} bundle verify ${bundle}`);
  assert.equal(fx.sh(`git -C ${restored} cat-file -t ${h.original}`), "commit");
  assert.equal(
    fx.sh(`git -C ${restored} cat-file -t ${before.state.head}`),
    "commit",
  );
  assert.equal(before.rebasing, true);
  assert.equal(before.remote, h.original);
  assert.deepEqual(retainedState(h), before);
});
