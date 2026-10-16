// @ts-check
// The claim helpers that talk to GitHub (raceForClaim, touchClaim and
// closeClaims), run against a fake gh and pinned to the comments, edits and
// labels ops.mjs made before they moved to src/claims.ts (#166).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMMENT } from "../src/comments.ts";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */

setEnv(
  "ISSUE_PIPELINE_ROOT",
  fs.mkdtempSync(path.join(os.tmpdir(), "claim-race-")),
);
const fakeGh = installFakeGh();
const { closeClaims, raceForClaim, touchClaim } = await import(
  "../src/claims.ts"
);

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
const req = { lane: "me", sweepId: "s9" };
const now = new Date().toISOString();
// The issue every test claims, this lane's claim on it, and the earlier
// claims of other lanes.
const ISSUE = 5;
const OWN_CLAIM = 7;
const HELD_CLAIM = 3;
const OTHER_CLAIM = 4;
const MS_PER_HOUR = 3_600_000;
// Past the config's three-hour lease.
const EXPIRED_HOURS = 4;
/** @param {string} lane @returns {string} */
function claimBody(lane) {
  return `**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n\nLane \`${lane}\` is claiming this issue.\n<!-- agent-pipeline:claim lane=${lane} sweep=s1 -->`;
}
/** @param {number} id @param {string} body @param {string} [login] @param {string} [at] @returns {object} */
function comment(id, body, login = "bot", at = now) {
  return githubComment({ id, body, login, created: at, updated: at });
}
const BODY_FIELD = /^body=/u;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
const STAMP = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ";
const LIST = "comments?per_page=100";
const POST_CLAIM = "POST repos/o/r/issues/5/comments";
const POSTED_CLAIM = signedClaim(
  "Lane `me` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.",
);
const POSTED_BODY = `${POSTED_CLAIM}\n<!-- agent-pipeline:claim lane=me sweep=s9 -->`;
// gh's answer to the claim's POST: the comment it made.
const POSTED = {
  when: POST_CLAIM,
  stdout: JSON.stringify(
    githubComment({
      id: OWN_CLAIM,
      body: POSTED_BODY,
      login: "bot",
      created: now,
    }),
  ),
};

// The text of a claim this lane posts in sweep s9, signed as the claim role.
/** @param {string} text @returns {string} */
function signedClaim(text) {
  return `**🤖 issue-pipeline · claim**\n<sub>deterministic step, no model · run \`s9\`</sub>\n<!-- agent-pipeline:comment role=claim -->\n\n${text}`;
}

// `text` as a regex source that matches it literally.
/** @param {string} text @returns {string} */
function literal(text) {
  return text.replace(REGEX_SPECIAL, "\\$&");
}

// The comment edits gh was asked for, as { id, body }.
/** @returns {{ id: string | undefined, body: string }[]} */
function edits() {
  return fakeGh
    .calls()
    .filter(([, , method]) => method === "PATCH")
    .map(([, , , url = "", , field = ""]) => ({
      id: url.split("/").pop(),
      body: field.replace(BODY_FIELD, ""),
    }));
}

test("a lane whose claim is the earliest live one wins, and labels the issue working", () => {
  fakeGh.reply([
    POSTED,
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, []), {
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
    `body=${POSTED_BODY}`,
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
  assert.equal(list?.[2], "repos/o/r/issues/5/comments?per_page=100");
  assert.deepEqual(rest, []);
});

test("a lane that sees an earlier claim after posting abandons its own", () => {
  fakeGh.reply([
    POSTED,
    {
      when: LIST,
      stdout: commentLines([
        comment(OWN_CLAIM, claimBody("me")),
        comment(HELD_CLAIM, claimBody("a")),
      ]),
    },
  ]);
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, []), {
    won: false,
    holder: "a",
    posted: true,
    waited: 0,
  });
  const [edit, ...more] = edits();
  assert.deepEqual(more, []);
  assert.ok(edit);
  assert.equal(edit.id, "7");
  assert.match(
    edit.body,
    new RegExp(
      `^${literal(`${POSTED_CLAIM}\n<!-- agent-pipeline:claim-closed lane=me sweep=s9 -->\n\nAbandoned `)}${STAMP}: lane \`a\` claimed this issue first\\. This lane takes another issue\\.$`,
      "u",
    ),
  );
});

test("a lane that can't see its own claim after posting abandons it", () => {
  fakeGh.reply([POSTED]);
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, []), {
    won: false,
    holder: null,
    posted: true,
    waited: 0,
  });
  const [edit] = edits();
  assert.ok(edit);
  assert.match(
    edit.body,
    new RegExp(
      `\n\nAbandoned ${STAMP}: this lane couldn't confirm its claim was first\\. This lane takes another issue\\.$`,
      "u",
    ),
  );
});

test("a lane doesn't claim an issue another lane holds, nor one it holds", () => {
  fakeGh.reply([]);
  const held = [COMMENT.parse(comment(HELD_CLAIM, claimBody("a")))];
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, held), {
    won: false,
    holder: "a",
    posted: false,
  });
  assert.deepEqual(
    raceForClaim(cfg, ISSUE, { lane: "a", sweepId: "s9" }, held),
    {
      won: true,
      claimId: 3,
      posted: false,
    },
  );
  assert.deepEqual(fakeGh.calls(), []);
});

test("touching a claim stamps it once, replacing an earlier stamp", () => {
  const stamped = `${claimBody("me")}\n<sub>Lane still working at 2026-01-01T00:00Z.</sub>`;
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
    {
      when: LIST,
      stdout: commentLines([
        comment(2, claimBody("a")),
        comment(OWN_CLAIM, stamped),
      ]),
    },
  ]);
  touchClaim(cfg, ISSUE, req);
  touchClaim(cfg, ISSUE, req);
  const stamp = new RegExp(
    `^${literal(`${claimBody("me")}\n<sub>Lane still working at `)}${STAMP}\\.</sub>$`,
    "u",
  );
  const [first, second, ...more] = edits();
  assert.deepEqual(more, []);
  assert.ok(first && second);
  assert.equal(first.id, "7");
  assert.match(first.body, stamp);
  assert.equal(second.id, "7");
  assert.match(second.body, stamp);
});

test("touching names the lane by its sweep when it has no lane name", () => {
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  touchClaim(cfg, ISSUE, { sweepId: "me" });
  assert.equal(edits()[0]?.id, "7");
  fakeGh.reply([
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  touchClaim(cfg, ISSUE, { sweepId: "other" });
  assert.deepEqual(edits(), []);
});

test("closing an issue's claims closes each live claim with the reason", () => {
  const old = new Date(Date.now() - EXPIRED_HOURS * MS_PER_HOUR).toISOString();
  fakeGh.reply([
    {
      when: LIST,
      stdout: commentLines([
        comment(1, claimBody("c"), "bot", old),
        comment(2, claimBody("a")),
        comment(HELD_CLAIM, claimBody("b"), "visitor"),
        comment(OTHER_CLAIM, claimBody("b")),
      ]),
    },
  ]);
  closeClaims(cfg, ISSUE, "merged");
  const closed = edits();
  assert.deepEqual(
    closed.map((edit) => edit.id),
    ["2", "4"],
  );
  const lanes = ["a", "b"];
  for (const [at, edit] of closed.entries()) {
    const lane = lanes[at];
    assert.ok(lane);
    assert.match(
      edit.body,
      new RegExp(
        `^${literal(claimBody(lane).replace("agent-pipeline:claim lane", "agent-pipeline:claim-closed lane"))}\n\nClosed ${STAMP}: merged$`,
        "u",
      ),
    );
  }
});
