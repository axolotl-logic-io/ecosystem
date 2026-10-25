// Who a control label may come from, through the real membership reads:
// only a person who is an active member of the configured organization,
// checked by user id. Machines, Apps and pull requests grant nothing; a
// reader that can't read memberships, or an unreadable answer, holds.
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeEvent } from "./fake-github-world.ts";
import {
  type Harness,
  harness,
  labelledIssue,
  mentions,
  REPO,
  taskAnswers,
} from "./signal-test-kit.ts";

const ISSUE = 3;
const EVENT = 4001;
// A user id GitHub reports for the event's actor that its membership
// doesn't name.
const STALE_USER_ID = 66;

// What a poll that holds only the start on ISSUE looks like, apart from
// the hold's reason: no signal, no post, one hold on the issue.
interface Held {
  outcome: {
    signals: number;
    holds: number;
    workItem: unknown;
    posts: number;
    complete: boolean;
  };
  reason: string;
}

function startBy(
  actor: string,
  edit: (event: FakeEvent) => void = () => undefined,
): Harness {
  return harness((world) => {
    const issue = labelledIssue(ISSUE, "start:implement", actor, EVENT);
    const [event] = issue.events;
    if (event !== undefined) {
      edit(event);
    }
    world.issues.push(issue);
    world.tasks.push(taskAnswers(ISSUE));
  });
}

function held(kit: Harness): Held {
  const inbox = kit.poll();
  const [first] = inbox.holds;
  return {
    outcome: {
      signals: inbox.signals.length,
      holds: inbox.holds.length,
      workItem: first?.workItem,
      posts: kit.posts(),
      complete: inbox.complete,
    },
    reason: first?.reason ?? "",
  };
}

function onlyHold(complete: boolean): Held["outcome"] {
  return {
    signals: 0,
    holds: 1,
    workItem: { repo: REPO, number: ISSUE },
    posts: 0,
    complete,
  };
}

test("machine labels grant nothing", () => {
  for (const [actor, why] of [
    ["lawd-landing", "@lawd-landing is a configured pipeline account"],
    ["renovate[bot]", "@renovate[bot] is a Bot account, not a person"],
  ] as const) {
    const answer = held(startBy(actor));
    assert.deepEqual(answer.outcome, onlyHold(true));
    assert.match(answer.reason, mentions(why));
  }
});

test("a member's label applied through a GitHub App grants nothing", () => {
  const answer = held(
    startBy("autumn", (event) => {
      event.viaApp = true;
    }),
  );
  assert.deepEqual(answer.outcome, onlyHold(true));
  assert.match(answer.reason, mentions("@autumn acted through a GitHub App"));
});

test("a pull request's label grants nothing", () => {
  const kit = harness((world) => {
    world.issues.push({
      ...labelledIssue(ISSUE, "start:implement", "autumn", EVENT),
      pullRequest: true,
    });
  });
  const inbox = kit.poll();
  assert.deepEqual(inbox, { signals: [], holds: [], complete: true });
  assert.equal(kit.posts(), 0);
});

test("non-members and pending invitations grant nothing", () => {
  const stranger = held(startBy("mallory"));
  assert.deepEqual(stranger.outcome, onlyHold(true));
  assert.match(stranger.reason, mentions("@mallory is not a member of acme"));
  const invited = held(startBy("pending-pat"));
  assert.deepEqual(invited.outcome, onlyHold(true));
  assert.match(
    invited.reason,
    mentions("@pending-pat's invitation to acme is pending"),
  );
});

test("membership answers without an organization object qualify by organization_url", () => {
  for (const organizationObject of [false, true]) {
    const kit = startBy("autumn");
    kit.change((world) => {
      world.organizationObject = organizationObject;
    });
    const inbox = kit.poll();
    assert.deepEqual(inbox.holds, []);
    assert.equal(inbox.signals.length, 1);
  }
});

test("a reader that is not an active member qualifies nobody", () => {
  const kit = startBy("autumn");
  kit.change((world) => {
    world.members = world.members.filter(
      (item) => item.login !== "lawd-landing",
    );
  });
  const answer = held(kit);
  assert.deepEqual(answer.outcome, onlyHold(false));
  assert.match(
    answer.reason,
    mentions("reader @lawd-landing cannot see organization acme"),
  );
});

test("an unreadable membership answer holds rather than rejecting", () => {
  const kit = startBy("autumn");
  kit.change((world) => {
    world.faults.push({
      path: "orgs/acme/memberships/autumn",
      page: null,
      status: 500,
      link: null,
    });
  });
  const answer = held(kit);
  assert.deepEqual(answer.outcome, onlyHold(false));
  assert.match(
    answer.reason,
    mentions("membership of @autumn unreadable: GET ", "answered HTTP 500"),
  );
});

test("a login whose membership belongs to another user id holds", () => {
  const answer = held(
    startBy("autumn", (event) => {
      event.actorId = STALE_USER_ID;
    }),
  );
  assert.deepEqual(answer.outcome, onlyHold(false));
  assert.match(
    answer.reason,
    mentions(
      `membership of @autumn belongs to another account than user ${STALE_USER_ID}`,
    ),
  );
});

test("an organization scope that isn't a GitHub name holds the whole poll", () => {
  const kit = startBy("autumn");
  const inbox = kit.poll("not an org");
  assert.deepEqual(inbox.signals, []);
  assert.equal(inbox.complete, false);
  assert.equal(inbox.holds[0]?.workItem, null);
  assert.equal(kit.calls().length, 0);
});
