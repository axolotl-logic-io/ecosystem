// Who a control label may come from, through the real membership reads:
// only a person who is an active member of the configured organization,
// checked by user id. Machines, Apps and pull requests grant nothing; a
// reader that can't read memberships, or an unreadable answer, holds.
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeEvent } from "./fake-github-world.ts";
import {
  harness,
  labelledIssue,
  REPO,
  taskAnswers,
} from "./signal-test-kit.ts";

const ISSUE = 3;
const EVENT = 4001;

function startBy(
  actor: string,
  edit: (event: FakeEvent) => void = () => undefined,
): ReturnType<typeof harness> {
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

function onlyHold(kit: ReturnType<typeof harness>): {
  reason: string;
  complete: boolean;
} {
  const inbox = kit.poll();
  assert.deepEqual(inbox.signals, []);
  assert.equal(inbox.holds.length, 1);
  assert.deepEqual(inbox.holds[0]?.workItem, { repo: REPO, number: ISSUE });
  assert.equal(kit.posts(), 0);
  return { reason: inbox.holds[0]?.reason ?? "", complete: inbox.complete };
}

test("machine labels grant nothing", () => {
  for (const [actor, why] of [
    ["lawd-landing", /@lawd-landing is a configured pipeline account/u],
    ["renovate[bot]", /@renovate\[bot\] is a Bot account, not a person/u],
  ] as const) {
    const held = onlyHold(startBy(actor));
    assert.match(held.reason, why);
    assert.equal(held.complete, true);
  }
});

test("a member's label applied through a GitHub App grants nothing", () => {
  const held = onlyHold(
    startBy("autumn", (event) => {
      event.viaApp = true;
    }),
  );
  assert.match(held.reason, /@autumn acted through a GitHub App/u);
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
  assert.match(
    onlyHold(startBy("mallory")).reason,
    /@mallory is not a member of acme/u,
  );
  assert.match(
    onlyHold(startBy("pending-pat")).reason,
    /@pending-pat's invitation to acme is pending/u,
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
  const held = onlyHold(kit);
  assert.match(
    held.reason,
    /reader @lawd-landing cannot see organization acme/u,
  );
  assert.equal(held.complete, false);
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
  const held = onlyHold(kit);
  assert.match(
    held.reason,
    /membership of @autumn unreadable: GET .* answered HTTP 500/u,
  );
  assert.equal(held.complete, false);
});

test("a login whose membership belongs to another user id holds", () => {
  const held = onlyHold(
    startBy("autumn", (event) => {
      event.actorId = 66;
    }),
  );
  assert.match(
    held.reason,
    /membership of @autumn belongs to another account than user 66/u,
  );
  assert.equal(held.complete, false);
});

test("an organization scope that isn't a GitHub name holds the whole poll", () => {
  const kit = startBy("autumn");
  const inbox = kit.poll("not an org");
  assert.deepEqual(inbox.signals, []);
  assert.equal(inbox.complete, false);
  assert.equal(inbox.holds[0]?.workItem, null);
  assert.equal(kit.calls().length, 0);
});
