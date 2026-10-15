// @ts-check
// The strict-TS ops modules in-process, against a fake gh: openPrFor's
// lookup, stop's fallback to the catch-all `error` stop, and save-state with
// no state (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
setEnv(
  "ISSUE_PIPELINE_ROOT",
  fs.mkdtempSync(path.join(os.tmpdir(), "ops-modules-")),
);
const fakeGh = installFakeGh();
const { openPrFor } = await import("../src/ops/prs.ts");
const { stop } = await import("../src/ops/stop.ts");
const { saveState } = await import("../src/ops/save-state.ts");

/** @type {Config} */
const cfg = {
  account: "bot",
  allowedUsers: ["alice"],
  baseBranch: "integration",
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  leaseHours: 3,
  practices: [],
  repo: "o/r",
  slug: "o__r",
};
// The issue openPrFor looks up, and the PR gh lists for its branch.
const ISSUE = 7;
const PR = 12;
const STOPPED_ISSUE = 8;
const SAVED_ISSUE = 9;
const PR_LIST = [
  "pr",
  "list",
  "-R",
  "o/r",
  "--head",
  "agent/issue-7",
  "--state",
  "open",
  "--json",
  "number",
];

test("openPrFor reads the issue branch's open PR", () => {
  fakeGh.reply([{ when: "pr list", stdout: '[{"number":12}]' }]);
  assert.equal(openPrFor(cfg, ISSUE), PR);
  assert.deepEqual(fakeGh.calls(), [PR_LIST]);
});

test("openPrFor finds no PR when gh lists none", () => {
  fakeGh.reply([]);
  assert.equal(openPrFor(cfg, ISSUE), undefined);
  assert.deepEqual(fakeGh.calls(), [PR_LIST]);
});

test("stop with an empty reason and no code is the error stop", () => {
  fakeGh.reply([]);
  const request = { number: STOPPED_ISSUE, reason: "", state: { stage: "plan" } };
  assert.deepEqual(stop(cfg, request), {
    code: "error",
    label: "agent:stopped-error",
  });
});

test("save-state with no state writes nothing", () => {
  fakeGh.reply([]);
  assert.deepEqual(saveState(cfg, { number: SAVED_ISSUE }), {});
  assert.deepEqual(fakeGh.calls(), []);
});
