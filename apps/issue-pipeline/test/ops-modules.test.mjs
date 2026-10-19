// @ts-check
// The strict-TS ops modules in-process, against a fake gh: openPrFor's
// lookup, stop's fallback to the catch-all `error` stop, and the refusals of a
// stop with no reason and a save-state with no state, which write nothing
// (#183; v2 requests need a reason and a state).
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFixture } from "./config-fixtures.mjs";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";
import { stopMutationReplies } from "./gh-mutation-fixtures.mjs";
import "./isolated-root-test-kit.mjs";

const fakeGh = installFakeGh();
fakeGh.requireReplies();
const { openPrFor } = await import("../src/ops/prs.ts");
const { stop } = await import("../src/ops/stop.ts");
const { saveState } = await import("../src/ops/save-state.ts");
const { ghIsRead } = await import("../src/github.ts");
const { newIssueState } = await import("../src/state.ts");

const cfg = configFixture();
// The issue openPrFor looks up, and the PR gh lists for its branch.
const ISSUE = 7;
const PR = 12;
const STOPPED_ISSUE = 8;
const SAVED_ISSUE = 9;
// The genuine saved-state comment edited by the stop.
const STATE_COMMENT = 31;
const BAD_STOP = /bad stop request/u;
const BAD_SAVE = /bad save-state request/u;
// gh answers only a lookup that names the issue's branch, agent/issue-<n>.
test("openPrFor reads the issue branch's open PR", () => {
  fakeGh.reply([{ when: "agent/issue-7 ", stdout: '[{"number":12}]' }]);
  assert.equal(openPrFor(cfg, ISSUE), PR);
});

test("openPrFor finds no PR when gh lists none", () => {
  fakeGh.reply([
    { when: "pr list -R o/r --head agent/issue-7 --state open", stdout: "[]" },
  ]);
  assert.equal(openPrFor(cfg, ISSUE), undefined);
});

test("stop with a reason no stop names and no code is the error stop", () => {
  const saved = newIssueState(STOPPED_ISSUE);
  fakeGh.reply([
    {
      when: `issues/${STOPPED_ISSUE}/comments?per_page`,
      stdout: commentLines([
        githubComment({
          id: STATE_COMMENT,
          login: cfg.mergeAccount,
          created: "2026-10-18T00:00:00Z",
          body: `<!-- agent-pipeline:state\n${JSON.stringify(saved)}\n-->`,
        }),
      ]),
      keep: true,
      persistState: true,
    },
    ...stopMutationReplies(STOPPED_ISSUE, {
      stateId: STATE_COMMENT,
      pr: null,
      code: "error",
    }),
  ]);
  const request = {
    number: STOPPED_ISSUE,
    reason: "something no stop names",
    state: saved,
  };
  const { code, label, state } = stop(cfg, request);
  assert.deepEqual(
    { code, label, stage: state.stage, stopCode: state.stopCode },
    {
      code: "error",
      label: "agent:stopped-error",
      stage: "stopped",
      stopCode: "error",
    },
  );
  assert.equal(state.stoppedStage, "author");
});

test("stop with an empty reason is refused, writing nothing", () => {
  fakeGh.reply([]);
  const request = {
    number: STOPPED_ISSUE,
    reason: "",
    state: newIssueState(STOPPED_ISSUE),
  };
  assert.throws(() => stop(cfg, request), BAD_STOP);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
});

test("save-state with no state is refused, writing nothing", () => {
  fakeGh.reply([]);
  assert.throws(() => saveState(cfg, { number: SAVED_ISSUE }), BAD_SAVE);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
});
