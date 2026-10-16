// @ts-check
// The sweep op through the ops CLI, pinned to the replies and gh calls it
// made before it moved to src/ops/sweep.ts (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ALLOWED,
  askOps,
  CONFIG,
  calls,
  commentsReply,
  configWith,
  ghCalls,
  issueComment,
  publicConfigOf,
  reply,
  root,
  stateComment,
  TIME,
} from "./ops-cli-test-kit.mjs";
import {
  candidate,
  LANE,
  leased,
  listComments,
  row,
  SWEEP_HEAD,
  sweepReplies,
  sweepReply,
  USER,
} from "./ops-sweep-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

const TIME_PATTERN = /\d{4}-\d\d-\d\dT[\d:.]+Z/gu;
const LIVE = new Date().toISOString();
const LAPSED = "2020-01-01T00:00:00Z";
const ASKED = "2026-01-01T00:00:00Z";
const ANSWERED = "2026-02-01T00:00:00Z";
const RESERVATIONS = path.join(root, "runs", "o__r", "reservations.json");
const CHILD_DEPTH = 2;
const CLAIM_CANDIDATES = 2;
// The mixed sweep's issues, one for each path through the sweep. Issue 5 and
// 14 are the parents named in the reservations file.
const MIXED = {
  stopped: 1,
  merged: 2,
  skipLabel: 3,
  stranger: 4,
  reservedParent: 5,
  blocked: 6,
  mine: 7,
  lapsed: 8,
  liveElsewhere: 9,
  answered: 10,
  unanswered: 11,
  child: 12,
  blocker: 13,
  ownParent: 14,
};
// The comments the mixed sweep reads: the asked state, leases and answers.
const COMMENT = {
  asked: 1,
  mine: 2,
  lapsed: 3,
  live: 4,
  answer: 5,
  notAnswer: 6,
  held: 7,
};
// The other tests' issues.
const NEW = 20;
const QUEUED = { oldest: 21, middle: 22, newest: 23 };
const NAMED = { stopped: 30, closed: 31, stranger: 32, held: 33 };

test("a sweep refuses to run when gh is logged in as another account", () => {
  reply([{ when: "api user", stdout: "mallory\n" }]);
  assert.deepEqual(askOps({ op: "sweep", ...LANE }), {
    ok: false,
    error: "gh is logged in as mallory, but the config's account is bot",
  });
  assert.deepEqual(calls(), [USER]);
});

// Another sweep's live and lapsed reservations, and one of this sweep's own.
function writeReservations() {
  fs.mkdirSync(path.dirname(RESERVATIONS), { recursive: true });
  fs.writeFileSync(
    RESERVATIONS,
    JSON.stringify({
      "parent-5": { sweepId: "other", at: LIVE },
      "parent-99": { sweepId: "other", at: LAPSED },
      "parent-14": { sweepId: "s1", at: LIVE },
    }),
  );
}

// One open issue for each path through the sweep.
const MIXED_ROWS = [
  row(MIXED.stopped, ["agent:stopped-error"]),
  row(MIXED.merged, ["agent:merged"]),
  row(MIXED.skipLabel, ["deploy"]),
  row(MIXED.stranger, [], { author: { login: "eve" } }),
  row(MIXED.reservedParent, ["agent:split"]),
  row(MIXED.blocked, [], {
    body: `<!-- agent-pipeline:after ${MIXED.blocker} -->`,
  }),
  row(MIXED.mine, ["agent:working"]),
  row(MIXED.lapsed, ["agent:working"]),
  row(MIXED.liveElsewhere, ["agent:working"]),
  row(MIXED.answered, ["agent:needs-info"]),
  row(MIXED.unanswered, ["agent:needs-info"]),
  row(MIXED.child, [], {
    body: `<!-- agent-pipeline:parent ${MIXED.reservedParent} depth ${CHILD_DEPTH} -->`,
  }),
  row(MIXED.blocker, []),
  row(MIXED.ownParent, ["agent:split"]),
];

// gh's replies to a sweep of MIXED_ROWS: the leases and answers it reads.
/** @returns {GhReply[]} */
function mixedReplies() {
  const asked = stateComment(COMMENT.asked, {
    stage: "triage",
    questionsAt: ASKED,
    lease: null,
  });
  const notAnswer = issueComment(
    COMMENT.notAnswer,
    "Hm.",
    ALLOWED,
    "2025-12-01T00:00:00Z",
  );
  return sweepReplies(MIXED_ROWS, [
    commentsReply(MIXED.mine, [leased(COMMENT.mine, "me", LIVE)]),
    commentsReply(MIXED.lapsed, [leased(COMMENT.lapsed, "other", LAPSED)]),
    commentsReply(MIXED.liveElsewhere, [leased(COMMENT.live, "other", LIVE)]),
    commentsReply(MIXED.answered, [
      asked,
      issueComment(COMMENT.answer, "Use X.", ALLOWED, ANSWERED),
    ]),
    commentsReply(MIXED.unanswered, [asked, notAnswer]),
  ]);
}

// What a sweep of MIXED_ROWS should reply under `config`.
/** @param {string} config @returns {object} */
function mixedSweepReply(config) {
  const items = [
    candidate(MIXED.mine, "mine"),
    candidate(MIXED.lapsed, "resume"),
    candidate(MIXED.answered, "answered"),
    candidate(MIXED.child, "new", CHILD_DEPTH),
    candidate(MIXED.blocker, "new"),
  ];
  // Issues the sweep counts as skipped: one by skipLabels, one by its author.
  const skipped = [MIXED.skipLabel, MIXED.stranger].length;
  return sweepReply({
    config: publicConfigOf(config),
    items,
    parents: [MIXED.ownParent],
    liveElsewhere: 1,
    skipped,
  });
}

test("a sweep sorts its candidates and skips, parks or reserves the rest", () => {
  const config = configWith({ skipLabels: ["deploy"] });
  writeReservations();
  reply(mixedReplies());
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    mixedSweepReply(config),
  );
  const read = [
    MIXED.mine,
    MIXED.lapsed,
    MIXED.liveElsewhere,
    MIXED.answered,
    MIXED.unanswered,
  ];
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    ghCalls.collaborator(ALLOWED),
    ...read.map(listComments),
  ]);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(RESERVATIONS, "utf8").replace(TIME_PATTERN, TIME),
    ),
    {
      "parent-5": { sweepId: "other", at: TIME },
      "parent-14": { sweepId: "s1", at: TIME },
    },
  );
});

test("a sweep with takeNewWork false skips new issues", () => {
  const config = configWith({ takeNewWork: false });
  reply(sweepReplies([row(NEW, [])]));
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    sweepReply({ config: publicConfigOf(config), items: [], skipped: 1 }),
  );
  assert.deepEqual(calls(), [...SWEEP_HEAD, ghCalls.collaborator(ALLOWED)]);
});

test("a sweep returns the oldest claimCandidates and counts the rest as waiting", () => {
  const { oldest, middle, newest } = QUEUED;
  const config = configWith({ claimCandidates: CLAIM_CANDIDATES });
  reply(sweepReplies([row(newest, []), row(oldest, []), row(middle, [])]));
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    sweepReply({
      config: publicConfigOf(config),
      items: [candidate(oldest, "new"), candidate(middle, "new")],
      waiting: 1,
    }),
  );
  assert.deepEqual(calls(), [...SWEEP_HEAD, ghCalls.collaborator(ALLOWED)]);
});

test("a sweep for one named issue takes it even when stopped", () => {
  const body = "<!-- agent-pipeline:parent 5 depth 1 -->";
  reply(sweepReplies([row(NAMED.stopped, ["agent:stopped-error"], { body })]));
  assert.deepEqual(
    askOps({ op: "sweep", only: NAMED.stopped, ...LANE }),
    sweepReply({
      config: publicConfigOf(CONFIG),
      items: [candidate(NAMED.stopped, "named", 1)],
    }),
  );
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    ghCalls.collaborator(ALLOWED),
    listComments(NAMED.stopped),
  ]);
});

test("a sweep for one named issue refuses an issue that isn't open", () => {
  reply(sweepReplies([]));
  assert.deepEqual(askOps({ op: "sweep", only: NAMED.closed, ...LANE }), {
    ok: false,
    error: `#${NAMED.closed} is not an open issue`,
  });
  assert.deepEqual(calls(), SWEEP_HEAD);
});

test("a sweep for one named issue refuses an author not allowed", () => {
  reply(sweepReplies([row(NAMED.stranger, [], { author: { login: "eve" } })]));
  assert.deepEqual(askOps({ op: "sweep", only: NAMED.stranger, ...LANE }), {
    ok: false,
    error: `#${NAMED.stranger} was opened by @eve, who is not on allowedUsers or not a collaborator`,
  });
  assert.deepEqual(calls(), SWEEP_HEAD);
});

test("a sweep for one named issue refuses an issue another live lane holds", () => {
  const n = NAMED.held;
  reply(
    sweepReplies(
      [row(n, ["agent:working"])],
      [commentsReply(n, [leased(COMMENT.held, "other", LIVE)])],
    ),
  );
  assert.deepEqual(askOps({ op: "sweep", only: n, ...LANE }), {
    ok: false,
    error: `#${n} is held by live lane other`,
  });
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    ghCalls.collaborator(ALLOWED),
    listComments(n),
  ]);
});
