// Review signals through the real inbox, fake gh and a local bare origin
// (`fix-answers-reviews`, `land-merges-the-pr`): a qualified person's
// standing approval or request for changes on the issue's linked PR is
// accepted once as an append-only record and delivered as a review. A
// machine's, a non-member's or a comment-only review grants nothing and
// holds nothing. A review that was dismissed or superseded, a reviewer who
// left the organization and a stop each make an accepted review inert.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { HumanProvenance, WorkItemRef } from "../../../src/domain.ts";
import type { FakeReview } from "../../support/signals/fake-github-world.ts";
import {
  type Harness,
  harness,
  LANDING,
  labelledIssue,
  mentions,
  OTHER_COMMIT,
  openPull,
  REPO,
  records,
  review,
  taskAnswers,
} from "../../support/signals/signal-test-kit.ts";

const ISSUE = 41;
const PR = 51;
const START_EVENT = 9101;
const STOP_EVENT = 9102;
const REVIEW_RECORD = 501;
const REQUESTED = z.looseObject({
  request: z.looseObject({ kind: z.string() }),
});
const CHANGES = 901;
const VERIFY_REVIEW = 902;
const BOT_REVIEW = 903;
const OUTSIDER_REVIEW = 904;
const COMMENT_REVIEW = 905;
const PENDING_REVIEW = 906;
const APPROVAL = 907;
const WORK_ITEM: WorkItemRef = { repo: REPO, number: ISSUE };
const AUTUMN: HumanProvenance = {
  route: "human",
  login: "autumn",
  userId: 10,
  organization: "acme",
};

function reviewId(id: number): string {
  return `github-review:${REPO}#${ISSUE}:${id}`;
}

// ISSUE, started by autumn so the inbox polls it, with its open PR at a
// fresh head that autumn requested changes on. The other reviews of that
// head grant nothing: Verify's own, a bot's, a non-member's, a pending
// invitee's and a later comment-only review. Returns the kit and the head.
function reviewed(): { kit: Harness; head: string } {
  const kit = harness((world) => {
    world.issues.push(
      labelledIssue(ISSUE, "start:implement", "autumn", START_EVENT),
    );
    world.tasks.push(taskAnswers(ISSUE));
    world.pulls = [openPull(ISSUE, PR)];
  });
  const head = kit.push(ISSUE);
  setReviews(kit, [
    review(CHANGES, "autumn", "CHANGES_REQUESTED", head),
    review(VERIFY_REVIEW, LANDING, "APPROVED", head),
    review(BOT_REVIEW, "renovate[bot]", "APPROVED", head),
    review(OUTSIDER_REVIEW, "mallory", "APPROVED", head),
    review(COMMENT_REVIEW, "autumn", "COMMENTED", head),
    review(PENDING_REVIEW, "pending-pat", "CHANGES_REQUESTED", head),
  ]);
  return { kit, head };
}

function setReviews(kit: Harness, reviews: readonly FakeReview[]): void {
  kit.change((world) => {
    const pull = world.pulls?.[0];
    if (pull !== undefined) {
      pull.reviews = [...reviews];
    }
  });
}

// What each of ISSUE's accepted records requests, in order.
function requested(kit: Harness): string[] {
  return records(kit.world(), ISSUE).map(
    (record) => REQUESTED.parse(record).request.kind,
  );
}

function addReview(kit: Harness, added: FakeReview): void {
  kit.change((world) => {
    world.pulls?.[0]?.reviews?.push(added);
  });
}

test("a member's standing review is accepted once and delivered as a review", () => {
  const { kit, head } = reviewed();
  const first = kit.poll();
  assert.deepEqual(first.holds, []);
  assert.equal(first.complete, true);
  const delivered = {
    kind: "review",
    id: reviewId(CHANGES),
    workItem: WORK_ITEM,
    review: { id: CHANGES, pr: PR, commit: head, state: "CHANGES_REQUESTED" },
    provenance: AUTUMN,
    recordId: REVIEW_RECORD,
  };
  assert.deepEqual(
    first.signals.map((signal) => signal.kind),
    ["start", "review"],
  );
  assert.deepEqual(first.signals[1], delivered);
  assert.deepEqual(records(kit.world(), ISSUE)[1], {
    version: 2,
    kind: "accepted",
    id: reviewId(CHANGES),
    workItem: WORK_ITEM,
    source: {
      kind: "github-review",
      pr: PR,
      review: { id: CHANGES, submittedAt: "2026-10-25T11:01:00Z" },
    },
    producer: AUTUMN,
    request: {
      kind: "review",
      review: { id: CHANGES, pr: PR, commit: head, state: "CHANGES_REQUESTED" },
    },
    acceptedBy: { buddyRun: "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11" },
  });
  const second = kit.poll();
  assert.deepEqual(second.signals, first.signals);
  assert.deepEqual(second.holds, []);
  assert.equal(kit.posts(), 2);
  const qualified = {
    status: "qualified",
    reason: "@autumn (user 10) is an active member of acme",
  };
  assert.deepEqual(kit.requalify(delivered), qualified);
  assert.deepEqual(
    kit.requalifyNow({
      id: reviewId(CHANGES),
      recordId: REVIEW_RECORD,
      workItem: WORK_ITEM,
    }),
    qualified,
  );
});

test("a review that no longer stands is not delivered and is revoked", () => {
  const { kit } = reviewed();
  const [, changes] = kit.poll().signals;
  const next = kit.push(ISSUE);
  addReview(kit, review(APPROVAL, "autumn", "APPROVED", next));
  const approved = kit.poll();
  assert.deepEqual(approved.holds, []);
  assert.deepEqual(
    approved.signals.map((signal) => signal.id),
    [`github-label:${REPO}#${ISSUE}:${START_EVENT}`, reviewId(APPROVAL)],
  );
  assert.partialDeepStrictEqual(approved.signals[1], {
    review: { id: APPROVAL, pr: PR, commit: next, state: "APPROVED" },
  });
  const superseded = kit.requalify(changes);
  assert.equal(superseded.status, "revoked");
  assert.match(
    superseded.reason,
    mentions(`review ${CHANGES} of PR #${PR} no longer stands`),
  );
  const approval = {
    id: reviewId(APPROVAL),
    recordId: REVIEW_RECORD + 1,
    workItem: WORK_ITEM,
  };
  assert.equal(kit.requalifyNow(approval).status, "qualified");
  kit.change((world) => {
    const dismissed = world.pulls?.[0]?.reviews?.find(
      (item) => item.id === APPROVAL,
    );
    if (dismissed !== undefined) {
      dismissed.state = "DISMISSED";
    }
  });
  assert.deepEqual(
    kit.poll().signals.map((signal) => signal.kind),
    ["start"],
  );
  assert.equal(kit.requalifyNow(approval).status, "revoked");
  assert.deepEqual(requested(kit), ["start", "review", "review"]);
  assert.equal(kit.posts(), requested(kit).length);
});

test("a reviewer who left the organization is revoked", () => {
  const { kit } = reviewed();
  const [, changes] = kit.poll().signals;
  kit.change((world) => {
    world.members = world.members.filter((item) => item.login !== "autumn");
  });
  const left = kit.poll();
  assert.deepEqual(left.signals, []);
  assert.ok(
    left.holds.some((hold) =>
      mentions(
        `accepted review ${reviewId(CHANGES)} revoked: @autumn is not a member of acme`,
      ).test(hold.reason),
    ),
  );
  assert.equal(kit.requalify(changes).status, "revoked");
});

test("a stop makes accepted reviews inert and accepts no new ones", () => {
  const { kit } = reviewed();
  const [, changes] = kit.poll().signals;
  kit.change((world) => {
    const [issue] = world.issues;
    if (issue !== undefined) {
      issue.labels.push("agents:stop");
      issue.events.push({
        id: STOP_EVENT,
        event: "labeled",
        label: "agents:stop",
        actor: "autumn",
        viaApp: false,
        createdAt: "2026-10-25T12:00:00Z",
      });
    }
  });
  addReview(kit, review(APPROVAL, "autumn", "APPROVED", OTHER_COMMIT));
  const stopped = kit.poll();
  assert.deepEqual(
    stopped.signals.map((signal) => signal.kind),
    ["stop"],
  );
  assert.deepEqual(stopped.holds, []);
  const revoked = kit.requalify(changes);
  assert.equal(revoked.status, "revoked");
  assert.match(
    revoked.reason,
    mentions(`#${ISSUE} is stopped by accepted stop`),
  );
  assert.deepEqual(requested(kit), ["start", "review", "stop"]);
  assert.equal(kit.posts(), requested(kit).length);
});

test("unreadable reviews or reviewers hold the issue and accept nothing", () => {
  const { kit } = reviewed();
  kit.change((world) => {
    world.faults.push({
      path: `repos/${REPO}/pulls/${PR}/reviews`,
      page: null,
      status: 500,
      link: null,
    });
  });
  const unreadable = kit.poll();
  assert.equal(unreadable.complete, false);
  assert.ok(
    unreadable.holds.some((hold) =>
      mentions(`PR #${PR}'s reviews unreadable: `, "answered HTTP 500").test(
        hold.reason,
      ),
    ),
  );
  kit.change((world) => {
    world.faults = [
      {
        path: "orgs/acme/memberships/autumn",
        page: null,
        status: 500,
        link: null,
      },
    ];
  });
  const unqualified = kit.poll();
  assert.equal(unqualified.complete, false);
  assert.ok(
    unqualified.holds.some((hold) =>
      mentions(
        `review ${CHANGES} of PR #${PR} not accepted: its reviewer can't be qualified`,
      ).test(hold.reason),
    ),
  );
  // Only the start was accepted.
  assert.equal(kit.posts(), 1);
  assert.equal(records(kit.world(), ISSUE).length, 1);
});
