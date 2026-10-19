// @ts-check
// close-pr: it closes an open draft with its signed comment, and leaves a PR
// that isn't open as it is, run through the ops CLI and the fake gh.
import assert from "node:assert/strict";
import { test } from "node:test";
import { okLine, opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("pr-ops-close");
const { ghIsRead } = await import("../src/github.ts");
const { fakeGh, ask } = fx;

const POST_ENDPOINT_ARGS = 4;
const CLOSED = { n: 10, pr: 60 };
const COORDINATOR_SIGNATURE = /agent-pipeline:comment role=coordinator/u;
const WIKI_ONLY = /lives only in the wiki/u;
const WIKI_BRANCH_10 = /`agent\/issue-10`/u;

// The gh calls since the last reply that change GitHub, by src/github.ts's
// own read/write rule.
/** @returns {string[][]} */
function writes() {
  return fakeGh.calls().filter((args) => !ghIsRead(args));
}

test("close-pr on a PR that is already closed writes nothing", () => {
  const { n, pr } = CLOSED;
  fakeGh.reply([{ when: "pr view", stdout: '{"state":"CLOSED"}' }]);
  const out = ask({ op: "close-pr", number: n, pr });
  assert.equal(out, okLine("close-pr", { pr, closed: true }));
  assert.deepEqual(writes(), []);
});

test("close-pr closes the draft with a signed comment naming the wiki branch", () => {
  const { n, pr } = CLOSED;
  fakeGh.reply([
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: `pr close ${pr} -R o/r`, stdout: "" },
    { when: `api -X POST repos/o/r/issues/${pr}/comments -f`, stdout: "" },
  ]);
  const out = ask({ op: "close-pr", number: n, pr });
  assert.equal(out, okLine("close-pr", { pr, closed: true }));
  const [posted = [], call = [], ...rest] = writes();
  assert.deepEqual(rest, []);
  assert.ok(!call.includes("--comment"));
  assert.deepEqual(posted.slice(0, POST_ENDPOINT_ARGS), [
    "api",
    "-X",
    "POST",
    `repos/o/r/issues/${pr}/comments`,
  ]);
  const [command, verb, closed] = call;
  assert.deepEqual([command, verb, closed], ["pr", "close", String(pr)]);
  const comment =
    posted.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
  assert.match(comment, COORDINATOR_SIGNATURE);
  assert.match(comment, WIKI_ONLY);
  assert.match(comment, WIKI_BRANCH_10);
});
