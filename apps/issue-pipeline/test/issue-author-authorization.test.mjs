// @ts-check
// Direct assignment never overrides the fresh issue author's authorization.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { issueReply, LANE, LIVE } from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  CONFIG,
  claimComment,
  commentsReply,
  configWith,
  reply,
  runDir,
  writes,
} from "./ops-cli-test-kit.mjs";

const { loadConfig, paths } = await import("../src/config.ts");
const { trustedInputsHash, writeIssueContext } = await import(
  "../src/issue-context.ts"
);
const { currentRevision } = await import("../src/revision.ts");
const { inputsOf: roleInputsOf } = await import("../src/job/role-inputs.ts");
const cfg = loadConfig(CONFIG);
const REFUSED =
  /issue author @.+ is not on allowedUsers or not a collaborator/u;
const FAILURE = z.object({ ok: z.literal(false), error: z.string() });
const SUCCESS = z.looseObject({
  ok: z.literal(true),
  state: z.object({ lease: z.object({ lane: z.string() }) }),
});
const NUMBER = 901;
const CLAIM_ID = 9010;

for (const login of ["visitor", ALLOWED]) {
  test(`direct claim refuses ${login} without author authority before clone, claim or lease`, () => {
    reply([
      issueReply(NUMBER, {
        user: { login },
        body: "Unauthorized requirements",
      }),
      { when: `collaborators/${ALLOWED}`, code: 1, keep: true },
    ]);
    const result = FAILURE.parse(
      askOps({ op: "claim", number: NUMBER, ...LANE }),
    );
    assert.match(result.error, REFUSED);
    assert.equal(fs.existsSync(paths.clone(cfg)), false);
    assert.equal(fs.existsSync(paths.worktree(cfg, NUMBER)), false);
    assert.equal(fs.existsSync(runDir(NUMBER)), false);
    assert.deepEqual(writes(), []);
  });
}

test("author revocation between jobs refuses the next claim and preserves earlier issue inputs", () => {
  const mine = claimComment(CLAIM_ID, LANE.lane, LANE.sweepId, LIVE);
  reply([
    issueReply(NUMBER, { user: { login: ALLOWED } }),
    commentsReply(NUMBER, []),
    { when: `issues/${NUMBER}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(NUMBER, [mine]),
  ]);
  const initial = SUCCESS.parse(
    askOps({ op: "claim", number: NUMBER, ...LANE }),
  );
  assert.equal(initial.state.lease.lane, LANE.lane);
  assert.ok(writes().length > 0);
  const file = path.join(runDir(NUMBER), "issue.md");
  const before = fs.readFileSync(file, "utf8");
  for (const { config, collaboratorCode } of [
    { config: CONFIG, collaboratorCode: 1 },
    {
      config: configWith({ allowedUsers: ["someone-else"] }),
      collaboratorCode: 0,
    },
  ]) {
    reply([
      issueReply(NUMBER, { user: { login: ALLOWED }, body: "Revoked edit" }),
      commentsReply(NUMBER, [mine]),
      { when: `collaborators/${ALLOWED}`, code: collaboratorCode, keep: true },
    ]);
    const result = FAILURE.parse(
      askOps({ op: "claim", config, number: NUMBER, ...LANE }),
    );
    assert.match(result.error, REFUSED);
    assert.deepEqual(writes(), []);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});

test("a stage input refresh observes collaborator revocation before writing or hashing edited requirements", () => {
  const n = NUMBER + 1;
  reply([issueReply(n, { user: { login: ALLOWED } }), commentsReply(n, [])]);
  const context = writeIssueContext(cfg, n);
  const before = fs.readFileSync(context.file, "utf8");
  assert.equal(
    typeof trustedInputsHash(cfg, context.issue, context.comments),
    "string",
  );
  reply([
    issueReply(n, { user: { login: ALLOWED }, body: "Revoked edit" }),
    commentsReply(n, []),
    { when: `collaborators/${ALLOWED}`, code: 1, keep: true },
  ]);
  assert.throws(() => currentRevision(cfg, n, null), REFUSED);
  assert.throws(() => trustedInputsHash(cfg, context.issue, []), REFUSED);
  assert.equal(fs.readFileSync(context.file, "utf8"), before);
  assert.deepEqual(writes(), []);
});

test("hashing cannot independently bless a visitor's title and body", () => {
  reply([]);
  const issue = {
    title: "Visitor task",
    body: "Untrusted",
    user: { login: "visitor" },
  };
  assert.throws(() => trustedInputsHash(cfg, issue, []), REFUSED);
  assert.deepEqual(writes(), []);
});

test("claimed input snapshots cannot expose requirements to a role after author revocation", () => {
  const snapshot = {
    issue: {
      title: "Assigned task",
      body: "Requirements",
      user: { login: ALLOWED },
    },
    comments: [],
  };
  reply([]);
  assert.equal(roleInputsOf(cfg, NUMBER, snapshot).issue.user.login, ALLOWED);
  reply([{ when: `collaborators/${ALLOWED}`, code: 1, keep: true }]);
  assert.throws(() => roleInputsOf(cfg, NUMBER, snapshot), REFUSED);
  assert.deepEqual(writes(), []);
});
