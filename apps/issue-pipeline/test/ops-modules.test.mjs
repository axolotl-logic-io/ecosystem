// The strict-TS ops modules in-process, against a fake gh: openPrFor's
// lookup, stop's fallback to the catch-all `error` stop, and save-state with
// no state (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";

process.env.ISSUE_PIPELINE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "ops-modules-"),
);
const fakeGh = installFakeGh();
const { openPrFor } = await import("../src/ops/prs.ts");
const { stop } = await import("../src/ops/stop.ts");
const { saveState } = await import("../src/ops/save-state.ts");

const cfg = {
  account: "bot",
  allowedUsers: ["alice"],
  claimWaitSeconds: [0, 0],
  commands: { test: "true" },
  leaseHours: 3,
  repo: "o/r",
  slug: "o__r",
};
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
  assert.equal(openPrFor(cfg, 7), 12);
  assert.deepEqual(fakeGh.calls(), [PR_LIST]);
});

test("openPrFor finds no PR when gh lists none", () => {
  fakeGh.reply([]);
  assert.equal(openPrFor(cfg, 7), undefined);
  assert.deepEqual(fakeGh.calls(), [PR_LIST]);
});

test("stop with an empty reason and no code is the error stop", () => {
  fakeGh.reply([]);
  const request = { number: 8, reason: "", state: { stage: "plan" } };
  assert.deepEqual(stop(cfg, request), {
    code: "error",
    label: "agent:stopped-error",
  });
});

test("save-state with no state writes nothing", () => {
  fakeGh.reply([]);
  assert.deepEqual(saveState(cfg, { number: 9 }), {});
  assert.deepEqual(fakeGh.calls(), []);
});
