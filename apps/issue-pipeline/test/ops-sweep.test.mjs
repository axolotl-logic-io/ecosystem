// The sweep op through the ops CLI, pinned to the replies and gh calls it
// made before it moved to src/ops/sweep.ts (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ACCOUNT,
  ALLOWED,
  askOps,
  CONFIG,
  calls,
  commentsReply,
  configWith,
  issueComment,
  labelsReply,
  publicConfigOf,
  reply,
  root,
  stateComment,
  TIME,
} from "./ops-cli-test-kit.mjs";

const TIME_PATTERN = /\d{4}-\d\d-\d\dT[\d:.]+Z/gu;
const LIVE = new Date().toISOString();
const LAPSED = "2020-01-01T00:00:00Z";
const ASKED = "2026-01-01T00:00:00Z";
const ANSWERED = "2026-02-01T00:00:00Z";
const RESERVATIONS = path.join(root, "runs", "o__r", "reservations.json");
const LANE = { lane: "me", sweepId: "s1" };
const USER = ["api", "user", "--jq", ".login"];
const LABEL_LIST = [
  "label",
  "list",
  "-R",
  "o/r",
  "--limit",
  "500",
  "--json",
  "name",
];
const ISSUE_LIST = [
  "issue",
  "list",
  "-R",
  "o/r",
  "--state",
  "open",
  "--limit",
  "300",
  "--json",
  "number,title,author,labels,createdAt,body",
];
const STATE_EXTRA = { pr: null };

function row(number, labels, extra = {}) {
  return {
    number,
    title: `Issue ${number}`,
    author: { login: ALLOWED },
    labels: labels.map((name) => ({ name })),
    createdAt: `2026-10-${String(number).padStart(2, "0")}`,
    body: "",
    ...extra,
  };
}

function listComments(n) {
  return [
    "api",
    "--paginate",
    `repos/o/r/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

function collaborator(login) {
  return ["api", `repos/o/r/collaborators/${login}`, "--silent"];
}

function sweepReplies(rows, more = []) {
  return [
    { when: "api user", stdout: `${ACCOUNT}\n` },
    labelsReply,
    { when: "issue list", stdout: JSON.stringify(rows) },
    ...more,
  ];
}

function leased(id, lane, at) {
  return stateComment(id, {
    stage: "implement",
    lease: { lane, sweepId: "x", at },
    ...STATE_EXTRA,
  });
}

const SWEEP_HEAD = [USER, LABEL_LIST, ISSUE_LIST];

function candidate(number, kind, priority, depth = 0) {
  return {
    number,
    title: `Issue ${number}`,
    kind,
    priority,
    createdAt: `2026-10-${String(number).padStart(2, "0")}`,
    depth,
  };
}

function sweepReply(extra) {
  return {
    ok: true,
    op: "sweep",
    posted: 0,
    waiting: 0,
    parents: [],
    liveElsewhere: 0,
    skipped: 0,
    ...extra,
  };
}

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
  row(1, ["agent:stopped-error"]),
  row(2, ["agent:merged"]),
  row(3, ["deploy"]),
  row(4, [], { author: { login: "eve" } }),
  row(5, ["agent:split"]),
  row(6, [], { body: "<!-- agent-pipeline:after 13 -->" }),
  row(7, ["agent:working"]),
  row(8, ["agent:working"]),
  row(9, ["agent:working"]),
  row(10, ["agent:needs-info"]),
  row(11, ["agent:needs-info"]),
  row(12, [], { body: "<!-- agent-pipeline:parent 5 depth 2 -->" }),
  row(13, []),
  row(14, ["agent:split"]),
];

// gh's replies to a sweep of MIXED_ROWS: the leases and answers it reads.
function mixedReplies() {
  const asked = stateComment(1, {
    stage: "triage",
    questionsAt: ASKED,
    lease: null,
  });
  return sweepReplies(MIXED_ROWS, [
    commentsReply(7, [leased(2, "me", LIVE)]),
    commentsReply(8, [leased(3, "other", LAPSED)]),
    commentsReply(9, [leased(4, "other", LIVE)]),
    commentsReply(10, [asked, issueComment(5, "Use X.", ALLOWED, ANSWERED)]),
    commentsReply(11, [
      asked,
      issueComment(6, "Hm.", ALLOWED, "2025-12-01T00:00:00Z"),
    ]),
  ]);
}

test("a sweep sorts its candidates and skips, parks or reserves the rest", () => {
  const config = configWith({ skipLabels: ["deploy"] });
  writeReservations();
  reply(mixedReplies());
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    sweepReply({
      config: publicConfigOf(config),
      items: [
        candidate(7, "mine", -1),
        candidate(8, "resume", 0),
        candidate(10, "answered", 1),
        candidate(12, "new", 2, 2),
        candidate(13, "new", 2),
      ],
      parents: [14],
      liveElsewhere: 1,
      skipped: 2,
    }),
  );
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    collaborator(ALLOWED),
    listComments(7),
    listComments(8),
    listComments(9),
    listComments(10),
    listComments(11),
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
  reply(sweepReplies([row(20, [])]));
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    sweepReply({ config: publicConfigOf(config), items: [], skipped: 1 }),
  );
  assert.deepEqual(calls(), [...SWEEP_HEAD, collaborator(ALLOWED)]);
});

test("a sweep returns the oldest claimCandidates and counts the rest as waiting", () => {
  const config = configWith({ claimCandidates: 2 });
  reply(sweepReplies([row(23, []), row(21, []), row(22, [])]));
  assert.deepEqual(
    askOps({ op: "sweep", config, ...LANE }),
    sweepReply({
      config: publicConfigOf(config),
      items: [candidate(21, "new", 2), candidate(22, "new", 2)],
      waiting: 1,
    }),
  );
  assert.deepEqual(calls(), [...SWEEP_HEAD, collaborator(ALLOWED)]);
});

test("a sweep for one named issue takes it even when stopped", () => {
  const body = "<!-- agent-pipeline:parent 5 depth 1 -->";
  reply(sweepReplies([row(30, ["agent:stopped-error"], { body })]));
  assert.deepEqual(
    askOps({ op: "sweep", only: 30, ...LANE }),
    sweepReply({
      config: publicConfigOf(CONFIG),
      items: [candidate(30, "named", 0, 1)],
    }),
  );
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    collaborator(ALLOWED),
    listComments(30),
  ]);
});

test("a sweep for one named issue refuses an issue that isn't open", () => {
  reply(sweepReplies([]));
  assert.deepEqual(askOps({ op: "sweep", only: 31, ...LANE }), {
    ok: false,
    error: "#31 is not an open issue",
  });
  assert.deepEqual(calls(), SWEEP_HEAD);
});

test("a sweep for one named issue refuses an author not allowed", () => {
  reply(sweepReplies([row(32, [], { author: { login: "eve" } })]));
  assert.deepEqual(askOps({ op: "sweep", only: 32, ...LANE }), {
    ok: false,
    error:
      "#32 was opened by @eve, who is not on allowedUsers or not a collaborator",
  });
  assert.deepEqual(calls(), SWEEP_HEAD);
});

test("a sweep for one named issue refuses an issue another live lane holds", () => {
  reply(
    sweepReplies(
      [row(33, ["agent:working"])],
      [commentsReply(33, [leased(7, "other", LIVE)])],
    ),
  );
  assert.deepEqual(askOps({ op: "sweep", only: 33, ...LANE }), {
    ok: false,
    error: "#33 is held by live lane other",
  });
  assert.deepEqual(calls(), [
    ...SWEEP_HEAD,
    collaborator(ALLOWED),
    listComments(33),
  ]);
});
