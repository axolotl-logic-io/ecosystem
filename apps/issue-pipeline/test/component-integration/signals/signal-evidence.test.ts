// Signal evidence through the real gh reads and journal: listings are read
// page by page and any failed or contradictory page holds instead of
// reading as empty; a label its events don't explain holds; accepted
// records are trusted only when landing-authored and never edited; and an
// uncertain append is journaled once, confirmed by reading, never repeated.
import assert from "node:assert/strict";
import test from "node:test";
import {
  harness,
  LANDING,
  labelledIssue,
  MARK,
  mentions,
  REPO,
  taskAnswers,
} from "../../support/signals/signal-test-kit.ts";

const ISSUE = 21;
const EVENT = 8001;
const RECORD = 500;
// Enough unrelated comments and events to span three pages of two.
const CHATTER = 5;
const CHATTER_COMMENTS = 100;

function startWorld(): ReturnType<typeof harness> {
  return harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
  });
}

test("every page of every listing is read through its Link header", () => {
  const kit = harness((world) => {
    world.pageSize = 2;
    const issue = labelledIssue(ISSUE, "start:implement", "autumn", EVENT);
    for (let at = 0; at < CHATTER; at += 1) {
      issue.comments.push({
        id: CHATTER_COMMENTS + at,
        author: "mallory",
        body: `chatter ${at}`,
        editor: null,
        createdAt: "2026-10-25T09:00:00Z",
      });
      issue.events.unshift({
        id: 10 + at,
        event: "mentioned",
        label: null,
        actor: "mallory",
        viaApp: false,
        createdAt: "2026-10-25T08:00:00Z",
      });
    }
    world.issues.push(issue);
    world.tasks.push(taskAnswers(ISSUE));
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.holds, []);
  assert.equal(inbox.signals.length, 1);
  const pages = kit
    .calls()
    .map((call) => call.args[4] ?? "")
    .filter((target) =>
      target.startsWith(`repos/${REPO}/issues/${ISSUE}/events`),
    );
  assert.deepEqual(pages, [
    `repos/${REPO}/issues/${ISSUE}/events?per_page=100&page=1`,
    `repos/${REPO}/issues/${ISSUE}/events?per_page=100&page=2`,
    `repos/${REPO}/issues/${ISSUE}/events?per_page=100&page=3`,
  ]);
});

test("a failed later page holds the listing instead of reading it as shorter", () => {
  const kit = harness((world) => {
    world.pageSize = 1;
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    world.issues.push(
      labelledIssue(ISSUE + 1, "start:implement", "autumn", EVENT + 1),
    );
    world.faults.push({
      path: `repos/${REPO}/issues`,
      page: 2,
      status: 502,
      link: null,
    });
    world.faults.push({
      path: `repos/${REPO}/issues/comments`,
      page: 1,
      status: 403,
      link: null,
    });
  });
  const inbox = kit.poll();
  assert.equal(inbox.complete, false);
  const general = inbox.holds.filter((hold) => hold.workItem === null);
  assert.equal(general.length, 2);
  assert.match(
    general[0]?.reason ?? "",
    mentions(
      "open issues labelled start:implement unreadable: ",
      "page=2 answered HTTP 502",
    ),
  );
  assert.match(
    general[1]?.reason ?? "",
    mentions("accepted-signal discovery unreadable: ", "answered HTTP 403"),
  );
});

test("a Link header that contradicts its page holds the listing", () => {
  for (const link of [
    `<https://api.github.com/repositories/4242/issues/${ISSUE}/events?per_page=100&page=3>; rel="next"`,
    `<https://api.github.com/repositories/4242/issues/${ISSUE}/events?per_page=50&page=2>; rel="next"`,
    `<https://evil.example/repos/${REPO}/issues/${ISSUE}/events?per_page=100&page=2>; rel="next"`,
    "garbage",
  ]) {
    const kit = startWorld();
    kit.change((world) => {
      world.faults.push({
        path: `repos/${REPO}/issues/${ISSUE}/events`,
        page: 1,
        status: 200,
        link,
      });
    });
    const inbox = kit.poll();
    assert.deepEqual(inbox.signals, []);
    assert.equal(inbox.complete, false);
    assert.match(
      inbox.holds[0]?.reason ?? "",
      mentions("contradictory Link header"),
    );
    assert.equal(kit.posts(), 0);
  }
});

test("a present label its latest event doesn't explain holds", () => {
  const kit = startWorld();
  kit.change((world) => {
    const [issue] = world.issues;
    issue?.events.push({
      id: EVENT + 1,
      event: "unlabeled",
      label: "start:implement",
      actor: "autumn",
      viaApp: false,
      createdAt: "2026-10-25T11:00:00Z",
    });
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.deepEqual(inbox.holds, [
    {
      workItem: { repo: REPO, number: ISSUE },
      reason:
        "start:implement is present but its latest label event does not explain it",
    },
  ]);
  assert.equal(kit.posts(), 0);
});

test("a lost acknowledgement is confirmed by reading the record back", () => {
  const kit = startWorld();
  kit.change((world) => {
    world.post = "lost-after-apply";
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox.holds, []);
  assert.equal(inbox.signals.length, 1);
  assert.deepEqual(kit.journal(ISSUE), []);
  assert.equal(kit.posts(), 1);
});

test("an unconfirmed append is journaled, held and never posted again", () => {
  const kit = startWorld();
  kit.change((world) => {
    world.post = "lost-before-apply";
  });
  const first = kit.poll();
  assert.deepEqual(first.signals, []);
  assert.equal(first.complete, false);
  assert.match(
    first.holds[0]?.reason ?? "",
    mentions(
      "uncertain accept-signal; preserve ",
      "coordination-uncertain.json and reconcile without retrying",
    ),
  );
  assert.deepEqual(kit.journal(ISSUE), ["coordination-uncertain.json"]);
  kit.change((world) => {
    world.post = "ok";
  });
  const second = kit.poll();
  assert.deepEqual(second.signals, []);
  assert.match(
    second.holds[0]?.reason ?? "",
    mentions("accepted signals held: uncertain coordination write retained"),
  );
  assert.equal(kit.posts(), 1);
  const latch = kit.latch(ISSUE);
  assert.equal(latch.state, "unknown");
});

test("records by anyone but the landing account, or edited, hold and never clear the latch", () => {
  const kit = startWorld();
  kit.poll();
  const body = kit.world().issues[0]?.comments[0]?.body ?? "";
  const untrusted =
    "signal record provenance unverifiable: comment 600 has untrusted author/editor provenance";
  for (const [forged, why] of [
    [
      { author: "mallory", editor: null },
      "comment 600 by @mallory claims to be a signal record",
    ],
    [{ author: LANDING, editor: "mallory" }, untrusted],
    [{ author: LANDING, editor: LANDING }, "signal record 600 was edited"],
  ] as const) {
    const copy = harness((world) => {
      const issue = labelledIssue(ISSUE, "bug", "autumn", EVENT);
      issue.comments.push({
        id: 600,
        body,
        createdAt: "2026-10-25T12:00:00Z",
        ...forged,
      });
      world.issues.push(issue);
      world.tasks.push(taskAnswers(ISSUE));
    });
    const inbox = copy.poll();
    assert.deepEqual(inbox.signals, []);
    assert.equal(inbox.holds.length, 1);
    assert.match(inbox.holds[0]?.reason ?? "", mentions(why));
    assert.equal(copy.latch(ISSUE).state, "unknown");
    assert.equal(copy.latchNow(ISSUE).state, "unknown");
  }
});

test("identical duplicate records merge and conflicting ones hold", () => {
  const kit = startWorld();
  kit.poll();
  const body = kit.world().issues[0]?.comments[0]?.body ?? "";
  kit.change((world) => {
    world.issues[0]?.comments.push({
      id: 601,
      author: LANDING,
      body: body.replace(
        "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11",
        "0e1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11",
      ),
      editor: null,
      createdAt: "2026-10-25T12:00:00Z",
    });
  });
  const merged = kit.poll();
  assert.deepEqual(merged.holds, []);
  assert.deepEqual(
    merged.signals.map((signal) => signal.recordId),
    [RECORD],
  );
  kit.change((world) => {
    world.issues[0]?.comments.push({
      id: 602,
      author: LANDING,
      body: body.replace(`"userId":10`, `"userId":11`),
      editor: null,
      createdAt: "2026-10-25T12:00:00Z",
    });
  });
  const conflicting = kit.poll();
  assert.deepEqual(conflicting.signals, []);
  assert.match(
    conflicting.holds[0]?.reason ?? "",
    mentions(`signal records ${RECORD} and 602 conflict`),
  );
  assert.ok(body.startsWith(MARK));
});

test("a start record of the retired Author task is skipped, neither delivered nor held", () => {
  const kit = startWorld();
  kit.poll();
  const body = kit.world().issues[0]?.comments[0]?.body ?? "";
  const retired = body
    .replace(`"label":"start:implement"`, `"label":"start:author"`)
    .replace(`"task":"implement"`, `"task":"author"`);
  assert.notEqual(retired, body);
  const copy = harness((world) => {
    const issue = labelledIssue(ISSUE, "bug", "autumn", EVENT);
    issue.comments.push({
      id: 600,
      author: LANDING,
      body: retired,
      editor: null,
      createdAt: "2026-10-25T12:00:00Z",
    });
    world.issues.push(issue);
    world.tasks.push(taskAnswers(ISSUE));
  });
  const inbox = copy.poll();
  assert.deepEqual(inbox.signals, []);
  assert.deepEqual(inbox.holds, []);
});

test("an earlier version's record, or a request its source doesn't make, holds", () => {
  const kit = startWorld();
  kit.poll();
  const body = kit.world().issues[0]?.comments[0]?.body ?? "";
  for (const forged of [
    body.replace(`"version":2`, `"version":1`),
    body.replace(`"task":"implement"`, `"task":"author"`),
  ]) {
    assert.notEqual(forged, body);
    const copy = harness((world) => {
      const issue = labelledIssue(ISSUE, "bug", "autumn", EVENT);
      issue.comments.push({
        id: 600,
        author: LANDING,
        body: forged,
        editor: null,
        createdAt: "2026-10-25T12:00:00Z",
      });
      world.issues.push(issue);
      world.tasks.push(taskAnswers(ISSUE));
    });
    const inbox = copy.poll();
    assert.deepEqual(inbox.signals, []);
    assert.match(
      inbox.holds[0]?.reason ?? "",
      mentions("signal record 600 is invalid or of an unknown version"),
    );
    assert.equal(copy.latchNow(ISSUE).state, "unknown");
  }
});
