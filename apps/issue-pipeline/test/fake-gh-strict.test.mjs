// @ts-check
// The opt-in strict fake denies unexpected effects and never persists failed writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import { initialWriteStateReply } from "./initial-write-state-fixtures.mjs";
import "./isolated-root-test-kit.mjs";

const ISSUE = 7;
const UNSUPPORTED = /unsupported private fake gh request/u;
const READ = [
  "api",
  "--paginate",
  `repos/o/r/issues/${ISSUE}/comments?per_page=100`,
];
const PATCH = [
  "api",
  "-X",
  "PATCH",
  `repos/o/r/issues/comments/${ISSUE}`,
  "-f",
];
const fake = installFakeGh();
fake.requireReplies();

/** @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
function gh(args) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([["GH_TOKEN", "fake-pipeline-merge--a"]]),
    },
  });
}

for (const args of [
  ["api", "repos/o/r/collaborators/outsider"],
  [
    "api",
    "-X",
    "POST",
    "repos/o/r/issues/999/labels",
    "-f",
    "labels[]=agent:working",
  ],
]) {
  test(`strict fake denies unexpected ${args.join(" ")} without fallback`, () => {
    fake.reply([]);
    const reply = gh(args);
    assert.equal(reply.status, 1);
    assert.match(reply.stderr, UNSUPPORTED);
    assert.equal(reply.stdout, "");
    assert.deepEqual(fake.calls(), [args]);
  });
}

test("unmatched and explicitly failed state PATCHes cannot mutate persisted authority; an allowed successful PATCH does", () => {
  const initial = initialWriteStateReply(ISSUE);
  const body = '<!-- agent-pipeline:state\n{"pr":42}\n-->';
  const patch = [...PATCH, `body=${body}`, "--silent"];
  for (const failure of [
    [],
    [{ when: PATCH.join(" "), code: 1, stderr: "save refused" }],
  ]) {
    fake.reply([initial, ...failure]);
    assert.equal(gh(patch).status, 1);
    assert.equal(gh(READ).stdout, initial.stdout);
  }
  fake.reply([initial, { when: PATCH.join(" "), stdout: "" }]);
  assert.equal(gh(patch).status, 0);
  const saved = JSON.parse(gh(READ).stdout);
  assert.equal(saved.body, body);
});
