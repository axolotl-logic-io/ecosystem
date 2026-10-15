// The claim helpers that talk to GitHub (raceForClaim, touchClaim and
// closeClaims), run against a fake gh and pinned to the comments, edits and
// labels ops.mjs made before they moved to src/claims.ts (#166).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { commentLines, installFakeGh } from "./fake-gh.mjs";

process.env.ISSUE_PIPELINE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "claim-race-"),
);
const fakeGh = installFakeGh();
const { closeClaims, raceForClaim, touchClaim } = await import(
  "../src/claims.ts"
);

const cfg = {
  account: "bot",
  repo: "o/r",
  leaseHours: 3,
  claimWaitSeconds: [0, 0],
};
const req = { lane: "me", sweepId: "s9" };
const now = new Date().toISOString();
function claimBody(lane) {
  return `**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n\nLane \`${lane}\` is claiming this issue.\n<!-- agent-pipeline:claim lane=${lane} sweep=s1 -->`;
}
function comment(id, body, login = "bot", at = now) {
  return { id, body, user: { login }, created_at: at, updated_at: at };
}
const BODY_FIELD = /^body=/u;
const STAMP = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ";
const LIST = "comments?per_page=100";
const POST_CLAIM = "POST repos/o/r/issues/5/comments";
const POSTED_CLAIM =
  "**🤖 issue-pipeline · claim**\n<sub>deterministic step, no model · run `s9`</sub>\n<!-- agent-pipeline:comment role=claim -->\n\nLane `me` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.";

// The comment edits gh was asked for, as { id, body }.
function edits() {
  return fakeGh
    .calls()
    .filter((args) => args[2] === "PATCH")
    .map((args) => ({
      id: args[3].split("/").pop(),
      body: args[5].replace(BODY_FIELD, ""),
    }));
}

test("a lane whose claim is the earliest live one wins, and labels the issue working", () => {
  fakeGh.reply([
    { when: POST_CLAIM, stdout: JSON.stringify({ id: 7, created_at: now }) },
    { when: LIST, stdout: commentLines([comment(7, claimBody("me"))]) },
  ]);
  assert.deepEqual(raceForClaim(cfg, 5, req, []), {
    won: true,
    claimId: 7,
    posted: true,
    waited: 0,
  });
  const [post, label, list, ...rest] = fakeGh.calls();
  assert.deepEqual(post, [
    "api",
    "-X",
    "POST",
    "repos/o/r/issues/5/comments",
    "-f",
    `body=${POSTED_CLAIM}\n<!-- agent-pipeline:claim lane=me sweep=s9 -->`,
  ]);
  assert.deepEqual(label, [
    "api",
    "-X",
    "POST",
    "repos/o/r/issues/5/labels",
    "--silent",
    "-f",
    "labels[]=agent:working",
  ]);
  assert.equal(list[2], "repos/o/r/issues/5/comments?per_page=100");
  assert.deepEqual(rest, []);
});

test("a lane that sees an earlier claim after posting abandons its own", () => {
  fakeGh.reply([
    { when: POST_CLAIM, stdout: JSON.stringify({ id: 7, created_at: now }) },
    {
      when: LIST,
      stdout: commentLines([
        comment(7, claimBody("me")),
        comment(3, claimBody("a")),
      ]),
    },
  ]);
  assert.deepEqual(raceForClaim(cfg, 5, req, []), {
    won: false,
    holder: "a",
    posted: true,
    waited: 0,
  });
  const [edit, ...more] = edits();
  assert.deepEqual(more, []);
  assert.equal(edit.id, "7");
  assert.match(
    edit.body,
    new RegExp(
      `^${RegExp.escape(`${POSTED_CLAIM}\n<!-- agent-pipeline:claim-closed lane=me sweep=s9 -->\n\nAbandoned `)}${STAMP}: lane \`a\` claimed this issue first\\. This lane takes another issue\\.$`,
      "u",
    ),
  );
});

test("a lane that can't see its own claim after posting abandons it", () => {
  fakeGh.reply([
    { when: POST_CLAIM, stdout: JSON.stringify({ id: 7, created_at: now }) },
  ]);
  assert.deepEqual(raceForClaim(cfg, 5, req, []), {
    won: false,
    holder: null,
    posted: true,
    waited: 0,
  });
  assert.match(
    edits()[0].body,
    new RegExp(
      `\n\nAbandoned ${STAMP}: this lane couldn't confirm its claim was first\\. This lane takes another issue\\.$`,
      "u",
    ),
  );
});

test("a lane doesn't claim an issue another lane holds, nor one it holds", () => {
  fakeGh.reply([]);
  const held = [comment(3, claimBody("a"))];
  assert.deepEqual(raceForClaim(cfg, 5, req, held), {
    won: false,
    holder: "a",
    posted: false,
  });
  assert.deepEqual(raceForClaim(cfg, 5, { lane: "a", sweepId: "s9" }, held), {
    won: true,
    claimId: 3,
    posted: false,
  });
  assert.deepEqual(fakeGh.calls(), []);
});

test("touching a claim stamps it once, replacing an earlier stamp", () => {
  const stamped = `${claimBody("me")}\n<sub>Lane still working at 2026-01-01T00:00Z.</sub>`;
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(7, claimBody("me"))]) },
    {
      when: LIST,
      stdout: commentLines([comment(2, claimBody("a")), comment(7, stamped)]),
    },
  ]);
  touchClaim(cfg, 5, req);
  touchClaim(cfg, 5, req);
  const stamp = new RegExp(
    `^${RegExp.escape(`${claimBody("me")}\n<sub>Lane still working at `)}${STAMP}\\.</sub>$`,
    "u",
  );
  const [first, second, ...more] = edits();
  assert.deepEqual(more, []);
  assert.equal(first.id, "7");
  assert.match(first.body, stamp);
  assert.equal(second.id, "7");
  assert.match(second.body, stamp);
});

test("touching names the lane by its sweep when it has no lane name", () => {
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(7, claimBody("me"))]) },
  ]);
  touchClaim(cfg, 5, { sweepId: "me" });
  assert.equal(edits()[0].id, "7");
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(7, claimBody("me"))]) },
  ]);
  touchClaim(cfg, 5, { sweepId: "other" });
  assert.deepEqual(edits(), []);
});

test("closing an issue's claims closes each live claim with the reason", () => {
  const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  fakeGh.reply([
    {
      when: LIST,
      stdout: commentLines([
        comment(1, claimBody("c"), "bot", old),
        comment(2, claimBody("a")),
        comment(3, claimBody("b"), "visitor"),
        comment(4, claimBody("b")),
      ]),
    },
  ]);
  closeClaims(cfg, 5, "merged");
  const closed = edits();
  assert.deepEqual(
    closed.map((edit) => edit.id),
    ["2", "4"],
  );
  for (const [edit, lane] of closed.map((item, at) => [item, ["a", "b"][at]])) {
    assert.match(
      edit.body,
      new RegExp(
        `^${RegExp.escape(claimBody(lane).replace("agent-pipeline:claim lane", "agent-pipeline:claim-closed lane"))}\n\nClosed ${STAMP}: merged$`,
        "u",
      ),
    );
  }
});
