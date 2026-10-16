// @ts-check
// The publish stage (src/workflow/stages/publish.ts), driven directly with
// recorded replies (#216): after the code merged, it publishes the issue's
// wiki commits and finishes the issue; a conflict goes to the conflict
// resolver, never to a patch file or a human, and the stage publishes again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/publish.ts";
import {
  CTX,
  replied,
  STAMP,
  sessionEnded,
  stateWith,
} from "./workflow-finish-test-kit.mjs";

/** @import { OpResult, StageState, Step } from "../src/workflow/stages/types.ts" */

const CONFLICT = {
  ok: true,
  published: false,
  conflict: true,
  inRebase: true,
  conflicts: ["Home.md"],
  baseSha: "abcdefabcdefabcdef",
  branch: "master",
};
const WIKI_REBASE = /onto the wiki's origin\/master/u;
const FIXED = { status: "fixed", summary: "Kept both paragraphs." };
const RESOLVED = { ok: true, resolved: true, headSha: "beef" };

/** @param {Partial<StageState["st"]>} [fields] @returns {StageState} */
function publishing(fields = {}) {
  const given = stateWith("publish", fields);
  return { ...given, paths: { ...given.paths, wiki: "/w/issue-7/wiki" } };
}

/** @param {Step} step @returns {string[]} */
function namesOf(step) {
  if (step.done) {
    return [];
  }
  return step.launches.map((launch) => launch.name);
}

// The step after the publish op answered `reply`.
/** @param {OpResult["reply"]} reply @param {Partial<StageState["st"]>} [fields] @returns {Step} */
function published(reply, fields = {}) {
  return replied(next, next(publishing(fields), CTX, []), reply);
}

// The step after a conflict was resolved and the rebase finished.
/** @returns {Step} */
function republished() {
  const resolving = published(CONFLICT);
  const ended = sessionEnded(next, resolving, {
    ok: true,
    structuredOutput: FIXED,
  });
  return replied(next, ended, RESOLVED);
}

test("publish asks ops to publish with the issue's state", () => {
  const given = publishing();
  const step = next(given, CTX, []);
  assert.equal(step.done, false);
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "publish",
      op: "publish",
      payload: { number: 7, state: given.st },
    },
  ]);
});

test("a clean publish closes the merged issue", () => {
  const step = published({ ok: true, published: true, sha: "c0ffee" });
  assert.deepEqual(
    [step.done, step.state.closed, step.state.outcome, step.state.st.stage],
    [true, true, "merged", "done"],
  );
  assert.equal(step.stop, null);
});

test("a publish conflict goes to the wiki's conflict resolver", () => {
  const step = published(CONFLICT);
  assert.equal(step.done, false);
  assert.equal(step.stop, null);
  const [launch] = step.launches;
  assert.ok(launch.kind === "child");
  assert.equal(launch.name, "conflicts-1");
  assert.match(launch.task, WIKI_REBASE);
  assert.equal(step.state.st.conflictFixes, 1);
});

test("a resolved publish conflict publishes again", () => {
  const step = republished();
  assert.deepEqual(namesOf(step), ["publish"]);
  assert.equal(step.comments.length, 1);
  const closed = replied(next, step, { ok: true, published: true, sha: "c" });
  assert.equal(closed.state.closed, true);
});

test("a second conflict in one sweep waits at publish for the next sweep", () => {
  const step = replied(next, republished(), CONFLICT);
  assert.deepEqual(
    [step.done, step.stop, step.state.closed],
    [true, null, false],
  );
  assert.equal(step.state.st.stage, "publish");
  assert.equal(
    step.state.st.log?.at(-1),
    `${STAMP} the wiki moved again while publishing; will retry next sweep`,
  );
});

test("a resolver that finds no resolution leaves the issue at publish", () => {
  const resolving = published(CONFLICT);
  const ended = sessionEnded(next, resolving, {
    ok: true,
    structuredOutput: { status: "cannot-fix", summary: "Too tangled." },
  });
  const step = replied(next, ended, {
    ok: true,
    resolved: false,
    reason: "Too tangled.",
  });
  assert.deepEqual(
    [step.done, step.stop, step.state.st.stage],
    [true, null, "publish"],
  );
  assert.equal(
    step.comments[0]?.body,
    "I couldn't resolve the conflicts with the wiki's master: Too tangled.",
  );
});

test("a publish conflict after the last resolution stops as a conflict", () => {
  const step = published(CONFLICT, { conflictFixes: 2 });
  assert.equal(
    step.stop?.reason,
    "rebasing the wiki onto master conflicts again after 2 resolutions",
  );
});

test("a failed publish stops, and one on the network defers", () => {
  const failed = published({ ok: false, error: "push refused" });
  assert.deepEqual(failed.stop, {
    reason: "could not publish the wiki changes",
    detail: "push refused",
    code: null,
  });
  const deferred = published({ ok: false, error: "gh exited 1: HTTP 502" });
  assert.equal(deferred.stop, null);
  assert.equal(deferred.state.st.stage, "publish");
});

test("a rejected resolution at the conflict limit stops as a conflict", () => {
  const resolving = published(CONFLICT, { conflictFixes: 1 });
  const ended = sessionEnded(next, resolving, {
    ok: true,
    structuredOutput: FIXED,
  });
  const step = replied(next, ended, {
    ok: true,
    resolved: false,
    reason: "conflict markers remain",
  });
  assert.equal(step.done, true);
  assert.equal(step.stop?.reason, "the conflict resolution was rejected");
  assert.equal(
    step.stop?.detail,
    "Conflicting files:\nHome.md\n\nconflict markers remain",
  );
  assert.equal(step.state.st.stage, "publish");
  assert.equal(step.state.closed, false);
});
