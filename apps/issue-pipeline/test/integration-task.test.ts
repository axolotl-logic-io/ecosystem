// Lawd's read-only Integration through the built ops (#185): it checks R on
// T only when R contains T and Hardening of exactly R on T passed, and every
// case, passing or not, leaves the origin, the PR and the issue's checkout
// untouched. Its only GitHub writes are the landing account's records.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  checkoutOf,
  forbiddenGhWrites,
  ISSUE,
  integrationWorld,
  originRefs,
  retainedPatch,
} from "./integration-task-test-kit.ts";
import {
  callMark,
  recordAttempt,
  runId,
  statusOf,
  writesSince,
} from "./task-results-test-kit.ts";

const LAND_FIRST = /a Land attempt is armed or uncertain/u;
const REWRITTEN = /\+a check rewrote me/u;
const MOVED_DURING = /moved during the checks/u;

type World = ReturnType<typeof integrationWorld>;

//  What an op may not change, read before it runs.
function untouched(world: World): {
  refs: string;
  checkout: { head: string; status: string };
  mark: number;
} {
  return {
    refs: originRefs(world.flow.origin),
    checkout: checkoutOf(world.wt),
    mark: callMark(world.flow.ghDir),
  };
}

// What changed since `before`: whether any origin ref moved, the issue's
// checkout, forbidden GitHub writes and how many records were appended.
function effectsSince(
  world: World,
  before: { refs: string; checkout: object; mark: number },
): {
  refsMoved: boolean;
  checkout: { head: string; status: string };
  forbidden: string[][];
  records: number;
} {
  return {
    refsMoved: originRefs(world.flow.origin) !== before.refs,
    checkout: checkoutOf(world.wt),
    forbidden: forbiddenGhWrites(world.flow.ghDir, before.mark),
    records: writesSince(world.flow.ghDir, before.mark).length,
  };
}

//  Only `records` landing-account records; nothing else moved.
function onlyRecords(
  before: { checkout: object },
  records: number,
): {
  refsMoved: boolean;
  checkout: object;
  forbidden: never[];
  records: number;
} {
  return {
    refsMoved: false,
    checkout: before.checkout,
    forbidden: [],
    records,
  };
}

test("Integration passes R on T with zero branch, PR or checkout effects, and never reruns a pass", () => {
  const world = integrationWorld();
  world.passed("Hardening");
  const before = untouched(world);
  const reply = world.integrate();
  assert.partialDeepStrictEqual(reply, {
    route: "security",
    verdict: "passed",
    checks: [{ id: "test", pass: true }],
  });
  assert.deepEqual(effectsSince(world, before), onlyRecords(before, 2));
  assert.equal(
    statusOf(world.flow, ISSUE, world.bound("Integration")).status,
    "passed",
  );
  const again = untouched(world);
  assert.partialDeepStrictEqual(world.integrate(), {
    route: "security",
    verdict: "passed",
  });
  assert.deepEqual(effectsSince(world, again), onlyRecords(again, 0));
});

test("a target without T, an R without T, a moved branch or missing Hardening is routed before any check", () => {
  const world = integrationWorld();
  const marker = path.join(world.flow.tmp, "checks-ran");
  world.setCheck(`touch ${marker}`);
  const before = untouched(world);
  assert.partialDeepStrictEqual(world.integrate(), {
    route: "hardening-needed",
  });
  world.passed("Hardening");
  const settled = untouched(world);
  const moved = world.advanceTarget("base.txt", "the target moved\n");
  assert.partialDeepStrictEqual(world.integrate(), { route: "sync-needed" });
  const onNewTarget = {
    ...world.bound("Integration"),
    target: { branch: "integration", commit: moved },
  };
  assert.partialDeepStrictEqual(world.integrate(onNewTarget), {
    route: "sync-needed",
  });
  const elsewhere = {
    ...onNewTarget,
    revision: { ...onNewTarget.revision, code: world.start },
  };
  assert.partialDeepStrictEqual(world.integrate(elsewhere), { route: "hold" });
  assert.equal(fs.existsSync(marker), false, "no check ran");
  assert.equal(
    writesSince(world.flow.ghDir, before.mark).length,
    2,
    "only Hardening's records",
  );
  assert.deepEqual(checkoutOf(world.wt), settled.checkout);
});

test("a failing check returns Developer work without a writer, and a retry is a new run", () => {
  const world = integrationWorld();
  world.setCheck("exit 3");
  world.passed("Hardening");
  const before = untouched(world);
  const reply = world.integrate();
  assert.partialDeepStrictEqual(reply, {
    route: "developer",
    verdict: "failed",
    checks: [{ id: "test", pass: false }],
  });
  assert.deepEqual(effectsSince(world, before), onlyRecords(before, 2));
  assert.partialDeepStrictEqual(
    statusOf(world.flow, ISSUE, world.bound("Integration")),
    {
      status: "missing",
      attempts: 1,
    },
  );
});

test("tracked changes the checks leave are retained as evidence, never committed or pushed", () => {
  const world = integrationWorld();
  world.setCheck("echo 'a check rewrote me' >> greet.txt");
  world.passed("Hardening");
  const before = untouched(world);
  const reply = world.integrate();
  assert.partialDeepStrictEqual(reply, {
    route: "developer",
    verdict: "failed",
  });
  assert.match(retainedPatch(String(reply.retained)), REWRITTEN);
  assert.equal(
    fs.readFileSync(
      path.join(String(reply.retained), "repo", "greet.txt"),
      "utf8",
    ),
    "hello\na check rewrote me\n",
  );
  assert.deepEqual(effectsSince(world, before), onlyRecords(before, 2));
});

test("a target that moves during the checks invalidates the result", () => {
  const world = integrationWorld();
  const { writer } = world;
  world.setCheck(
    `git -C ${writer} -c user.name=Other -c user.email=other@example.com commit -q --allow-empty -m 'moved during checks' && git -C ${writer} push -q origin HEAD:refs/heads/integration`,
  );
  world.passed("Hardening");
  const branch = world.remoteBranch();
  const reply = world.integrate();
  assert.partialDeepStrictEqual(reply, {
    route: "sync-needed",
    verdict: "failed",
  });
  assert.match(String(reply.reason), MOVED_DURING);
  assert.notEqual(world.remoteTarget(), world.start);
  assert.equal(world.remoteBranch(), branch);
  assert.notEqual(
    statusOf(world.flow, ISSUE, world.bound("Integration")).status,
    "passed",
  );
});

test("an armed or uncertain Land holds Integration before any check", () => {
  const world = integrationWorld();
  world.passed("Hardening");
  recordAttempt(world.flow, ISSUE, world.bound("Land"), {
    id: runId(),
    previous: null,
  });
  const before = untouched(world);
  const reply = world.integrate();
  assert.equal(reply.ok, false);
  assert.match(String(reply.error), LAND_FIRST);
  assert.deepEqual(effectsSince(world, before), onlyRecords(before, 0));
});
