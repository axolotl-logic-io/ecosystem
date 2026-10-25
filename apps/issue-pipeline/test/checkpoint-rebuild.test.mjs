// @ts-check
// A replacement run rebuilds the exact checkpoint GitHub records (#173).
// The disposable local caches (the clone and the mirror) are deleted between
// two real jobs; the next job starts from the saved head on the branch, not
// from anything local. When the saved checkpoint is missing from GitHub,
// the job stops for explicit recovery instead of starting again from the
// base. The built job and ops run against the fake GitHub, a local origin
// and fake pi.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readWorld, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import { runStage } from "./pipeline-flow-run-test-kit.mjs";
import {
  implementorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.mjs";
import {
  bareGit,
  ISSUE,
  refIn,
  SLUG,
  scriptPi,
  setUpFlow,
} from "./pipeline-flow-test-kit.mjs";

const BRANCH = `refs/heads/agent/issue-${ISSUE}`;
const HIPPY = ["--hardening-buddy", "hippy"];
const MISSING = /the saved checkpoint is missing from GitHub/u;

/**
 * A flow whose issue Implementation has saved at review with R pushed.
 * @returns {{ flow: import("./pipeline-flow-test-kit.mjs").Flow, implemented: string }}
 */
function implementedFlow() {
  const flow = setUpFlow();
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  scriptPi(flow, {
    implementor: [
      implementorTurn("Hello, world!", "Greet visitors"),
      {
        files: { "repo/greet.txt": "Hello, polite world!\n" },
        commits: [["-am", "Harden the greeting"]],
        output: { outcome: "done", summary: "Hardened the greeting" },
      },
    ],
  });
  const { end } = runStage(flow, "implement");
  const implemented = String(refIn(flow.origin, BRANCH));
  if (
    end !== "next" ||
    savedState(readWorld(flow.ghDir)).headSha !== implemented
  ) {
    throw new Error(`Implementation ended ${end} without saving R`);
  }
  return { flow, implemented };
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function sessions(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true);
}

test("with the clone and mirror deleted, Hardening rebuilds exactly R from GitHub and builds on it", () => {
  const { flow, implemented } = implementedFlow();
  const caches = [
    path.join(flow.root, "clones", SLUG),
    path.join(flow.root, "work", SLUG),
  ];
  for (const cache of caches) {
    assert.equal(fs.existsSync(cache), true, cache);
    fs.rmSync(cache, { recursive: true });
  }
  const evidence = path.join(flow.root, "runs", SLUG, `issue-${ISSUE}`);
  assert.equal(fs.existsSync(evidence), true, "runs/ is evidence, not cache");
  assert.equal(runStage(flow, "review", ISSUE, HIPPY).end, "next");
  const hardened = String(refIn(flow.origin, BRANCH));
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${hardened}^`]),
    implemented,
  );
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "merge");
  assert.equal(state.hardened.code, hardened);
});

test("a saved checkpoint missing from GitHub stops for recovery: no session, no restart from the base", () => {
  const { flow, implemented } = implementedFlow();
  // Deleting a PR's head branch closes the PR; GitHub keeps its last head.
  bareGit(flow.origin, ["update-ref", "-d", BRANCH]);
  withWorld(flow.ghDir, (world) => {
    for (const pr of world.prs) {
      Object.assign(pr, { state: "CLOSED", closedHead: implemented });
    }
  });
  const before = sessions(flow).length;
  const line = runStage(flow, "review", ISSUE, HIPPY);
  assert.equal(line.end, "stop");
  assert.match(String(line.reason), MISSING);
  assert.match(String(line.reason), new RegExp(implemented, "u"));
  assert.equal(sessions(flow).length, before, "no session reimplements it");
  assert.equal(refIn(flow.origin, BRANCH), null, "nothing pushed from base");
  const state = savedState(readWorld(flow.ghDir));
  assert.equal(state.stage, "stopped");
  assert.equal(state.headSha, implemented, "the checkpoint stays recorded");
});
