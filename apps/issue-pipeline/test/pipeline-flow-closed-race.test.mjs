// @ts-check
// A real authorized branch POST lands and auto-closes its issue, but delayed
// PR confirmation refuses the merge receipt. Canonical jobs must reconcile
// without inventing own-merge authority or repeating the code mutation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { ghCalls } from "./pipeline-flow-gh.mjs";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { opsTrace } from "./pipeline-flow-ops-test-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import {
  createReplayFlow,
  merges,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import {
  hardeningTurn,
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

const CLAIM_AUTHORITY = z.object({
  state: z.object({ hardened: z.unknown(), integration: z.unknown() }),
});

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {string | null} */
let originalWiki;
let traceStart = 0;
before(() => {
  flow = setUpFlow();
  ({ originalWiki } = createReplayFlow(flow, true));
});
after(() => stopJobs(flow));

test("the accepted merge auto-closes the issue before delayed confirmation stops Merge without an own receipt", () => {
  const stopped = savedState(readWorld(flow.ghDir));
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.stoppedStage, "merge");
  assert.equal(stopped.stopCode, "merge-refused");
  assert.equal(stopped.merged, null);
  assert.equal(stopped.codeMerged, null);
  assert.equal(stopped.security, null);
  const issue = readWorld(flow.ghDir).issues.find(
    ({ number }) => number === ISSUE,
  );
  assert.equal(issue?.state, "closed");
  assert.equal(merges(flow).length, 1);
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  assert.notEqual(merged, stopped.integration.revision.code);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
});

test("canonical closed recovery reopens and reconciles but does not invent own-merge authorization", () => {
  const stopped = savedState(readWorld(flow.ghDir));
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  withWorld(flow.ghDir, (world) => {
    world.delayMergeConfirmation = false;
  });
  fs.writeFileSync(path.join(flow.piDir, "counts.json"), "{}");
  scriptPi(flow, { reviewer: [hardeningTurn(), securityTurn()] });
  traceStart = opsTrace(flow).length;
  const callsStart = ghCalls(flow.ghDir).length;
  const starts = sessions(flow);
  // No durable own receipt: a merged fact alone must return to hardening.
  assert.equal(runStage(flow, "merge").end, "next");
  const recovered = savedState(readWorld(flow.ghDir));
  assert.equal(recovered.stage, "review");
  assert.deepEqual(recovered.codeMerged, { pr: stopped.pr, sha: merged });
  assert.equal(recovered.merged, null);
  const claimed = CLAIM_AUTHORITY.parse(
    opsTrace(flow)
      .slice(traceStart)
      .find(({ request }) => request.op === "claim")?.reply,
  );
  assert.deepEqual(claimed.state.hardened, stopped.hardened);
  assert.deepEqual(claimed.state.integration, stopped.integration);
  assert.equal(recovered.hardened, null);
  assert.equal(recovered.integration, null);
  assert.equal(sessions(flow), starts);
  assert.equal(
    readWorld(flow.ghDir).issues.find(({ number }) => number === ISSUE)?.state,
    "open",
  );
  assert.ok(
    ghCalls(flow.ghDir)
      .slice(callsStart)
      .some(
        ([command, action, target]) =>
          command === "issue" &&
          action === "reopen" &&
          target === String(ISSUE),
      ),
  );
});

test("postmerge hardening and actual-result checks precede read-only exact Security and wiki publication", () => {
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  assert.equal(runStage(flow, "review").end, "next");
  const hardened = savedState(readWorld(flow.ghDir));
  assert.equal(hardened.hardened.code, merged);
  assert.equal(hardened.merged, null);
  assert.equal(hardened.security, null);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );

  // Interrupt publication to inspect durable exact Security before wiki writes.
  fs.writeFileSync(
    path.join(flow.root, "interrupt-publish"),
    "pause publication",
  );
  assert.equal(runStage(flow, "merge").end, "deferred");
  const cleared = savedState(readWorld(flow.ghDir));
  assert.deepEqual(cleared.security.revision, {
    code: merged,
    wiki: hardened.hardened.wiki,
    inputs: hardened.hardened.inputs,
  });
  assert.equal(cleared.security.finding, null);
  assert.ok(cleared.security.commentId > 0);
  const security = piLog(flow.piDir)
    .filter((entry) => entry.start === true)
    .at(-1);
  assert.equal(security?.commitScope, false);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    originalWiki,
  );
});

test("exact clearance permits publication and completion with merged labels and completed closure", () => {
  const cleared = savedState(readWorld(flow.ghDir));
  fs.unlinkSync(path.join(flow.root, "interrupt-publish"));
  const clearedStarts = sessions(flow);
  assert.equal(runStage(flow, "merge").end, "next");
  assert.equal(sessions(flow), clearedStarts);
  const world = readWorld(flow.ghDir);
  const done = savedState(world);
  assert.equal(done.stage, "done");
  assert.deepEqual(done.security, cleared.security);
  assert.equal(
    refIn(flow.wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
    done.security.revision.wiki,
  );
  const completed = world.issues.find(({ number }) => number === ISSUE);
  assert.equal(completed?.state, "closed");
  assert.equal(completed?.stateReason, "completed");
  assert.ok(completed?.labels.includes("agent:merged"));
  assert.ok(
    world.issues
      .find(({ number }) => number === done.pr)
      ?.labels.includes("agent:merged"),
  );
});

test("recovery verified the actual result without another code push or merge POST", () => {
  const world = readWorld(flow.ghDir);
  const merged = refIn(flow.origin, `refs/heads/${BASE}`);
  const trace = opsTrace(flow).slice(traceStart);
  const verified = trace.filter(({ request }) => request.op === "verify");
  assert.ok(verified.length > 0);
  assert.ok(
    verified.every(
      ({ reply: { pass, headSha } }) => pass === true && headSha === merged,
    ),
  );
  assert.ok(
    trace.some(
      ({ request, reply: { pass } }) =>
        request.op === "wiki-check" && pass === true,
    ),
  );
  // A postmerge hardening push is wiki-only; no code push or second merge.
  assert.ok(
    trace
      .filter(({ request }) => request.op === "push")
      .every(
        ({ request }) => "wikiOnly" in request && request.wikiOnly === true,
      ),
  );
  assert.equal(
    trace.some(({ request }) =>
      ["merge", "exit-push", "sync-base"].includes(request.op),
    ),
    false,
  );
  assert.equal(merges(flow).length, 1);
  assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), merged);
  assert.deepEqual(world.unsupported, []);
});
