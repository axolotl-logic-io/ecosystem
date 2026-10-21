// @ts-check
// The claim helpers that talk to GitHub (raceForClaim, touchClaim and
// closeClaims), run against a fake gh: which claims they post, edit, close
// and label, and the markers and notes on them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFixture } from "./config-fixtures.mjs";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";
import { bodyOf, effectNames, effectsOf } from "./gh-effects-test-kit.mjs";
import { commentWriteReplies, labelReplies } from "./gh-mutation-fixtures.mjs";
import "./isolated-root-test-kit.mjs";

/** @import { GhEffect } from "./gh-effects-test-kit.mjs" */

const fakeGh = installFakeGh();
const { COMMENT } = await import("../src/comments.ts");
const { closeClaims, raceForClaim, touchClaim } = await import(
  "../src/claims.ts"
);
const { ghIsRead } = await import("../src/github.ts");

const cfg = configFixture();
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
const STAMP = /\d{4}-\d\d-\d\dT\d\d:\d\dZ/gu;
const EARLIER_STAMP = "2026-01-01T00:00Z";
const ABANDONED = /Abandoned .*This lane takes another issue/u;
const LIST = "comments?per_page=100";
const POST_CLAIM = "POST repos/o/r/issues/5/comments";
const POSTED_CLAIM = signedClaim(
  "Lane `me` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.",
);
const CLAIM_MARK = "<!-- agent-pipeline:claim lane=me sweep=s9 -->";
const CLOSED_MARK = "<!-- agent-pipeline:claim-closed lane=me sweep=s9 -->";
const POSTED_BODY = `${POSTED_CLAIM}\n${CLAIM_MARK}`;
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

// What gh's writes show on GitHub.
/** @returns {GhEffect[]} */
function effects() {
  return effectsOf(fakeGh.writes(ghIsRead));
}

// The comment edits gh was asked for, as { id, body }, with times replaced.
/** @returns {{ id: string, body: string }[]} */
function edits() {
  return effects().map(({ effect, body }) => ({
    id: effect.replace("edit comment ", "").replace(" role=claim", ""),
    body: body.replace(STAMP, "<time>"),
  }));
}

/** @param {readonly import("./fake-gh.mjs").GhReply[]} replies @returns {void} */
function scriptReplies(replies) {
  fakeGh.reply([
    ...replies,
    ...commentWriteReplies("o/r", ISSUE, [OWN_CLAIM, 2, OTHER_CLAIM]),
  ]);
}

test("a lane whose claim is the earliest live one wins, and labels the issue working", () => {
  scriptReplies([
    POSTED,
    ...labelReplies("o/r", ISSUE, ["agent:working"], []),
    ...commentWriteReplies("o/r", ISSUE, [OWN_CLAIM]),
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, []), {
    won: true,
    claimId: 7,
    posted: true,
  });
  const won = effects();
  assert.deepEqual(effectNames(won), [
    "comment #5 role=claim",
    "label #5 agent:working",
  ]);
  assert.ok(bodyOf(won, "comment #5 role=claim").includes(CLAIM_MARK));
});

test("a lane that sees an earlier claim after posting abandons its own", () => {
  scriptReplies([
    POSTED,
    ...labelReplies("o/r", ISSUE, ["agent:working"], []),
    ...commentWriteReplies("o/r", ISSUE, [OWN_CLAIM]),
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
  });
  const abandoned = effects();
  assert.deepEqual(effectNames(abandoned), [
    "comment #5 role=claim",
    "edit comment 7 role=claim",
    "label #5 agent:working",
  ]);
  const edit = bodyOf(abandoned, "edit comment 7 role=claim");
  assert.ok(edit.includes(CLOSED_MARK));
  assert.match(edit, ABANDONED);
  assert.ok(edit.includes("lane `a` claimed this issue first"));
});

test("a lane that can't see its own claim after posting abandons it", () => {
  scriptReplies([
    POSTED,
    { when: LIST, stdout: "" },
    ...commentWriteReplies("o/r", ISSUE, [OWN_CLAIM]),
    ...labelReplies("o/r", ISSUE, ["agent:working"], []),
  ]);
  assert.deepEqual(raceForClaim(cfg, ISSUE, req, []), {
    won: false,
    holder: null,
    posted: true,
  });
  const edit = bodyOf(effects(), "edit comment 7 role=claim");
  assert.ok(edit.includes(CLOSED_MARK));
  assert.match(edit, ABANDONED);
});

test("a lane doesn't claim an issue another lane holds, nor one it holds", () => {
  scriptReplies([]);
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
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
});

test("touching a claim stamps it once, replacing an earlier stamp", () => {
  const stamped = `${claimBody("me")}\n<sub>Lane still working at ${EARLIER_STAMP}.</sub>`;
  scriptReplies([
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
  const [first, second, ...more] = edits();
  assert.deepEqual(more, []);
  assert.ok(first && second);
  assert.deepEqual([first.id, second.id], ["7", "7"]);
  assert.ok(first.body.startsWith(claimBody("me")), "keeps the claim live");
  assert.notEqual(first.body, claimBody("me"), "stamps it");
  // Touching a stamped claim replaces the stamp rather than adding one.
  assert.equal(second.body, first.body);
});

test("touching names the lane by its sweep when it has no lane name", () => {
  scriptReplies([
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  touchClaim(cfg, ISSUE, { sweepId: "me" });
  assert.equal(edits()[0]?.id, "7");
  scriptReplies([
    { when: LIST, stdout: commentLines([comment(OWN_CLAIM, claimBody("me"))]) },
  ]);
  touchClaim(cfg, ISSUE, { sweepId: "other" });
  assert.deepEqual(edits(), []);
});

test("closing an issue's claims closes each live claim with the reason", () => {
  const old = new Date(Date.now() - EXPIRED_HOURS * MS_PER_HOUR).toISOString();
  scriptReplies([
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
    assert.ok(edit.body.includes(`claim-closed lane=${lane} sweep=s1`));
    assert.ok(edit.body.endsWith(": merged"), "gives the reason");
  }
});
