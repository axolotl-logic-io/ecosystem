import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { after, test } from "node:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { z } from "zod";
import { openDatabase } from "../../src/client.ts";
import { executeCoordination } from "../../src/coordination.ts";
import type { Binding, Command, Result, Scope } from "../../src/protocol.ts";
import { VIEW } from "../../src/protocol.ts";
import {
  claims,
  consumers,
  events,
  pools,
} from "../../src/tables/coordination.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../support/test-database.ts";

const at: TestDatabase = await createTestDatabase();
after(async (): Promise<void> => {
  await at.close();
});
const ISSUE: Scope = { kind: "issue", issue: 1 };
const RESOURCE: Scope = { kind: "model-session", slot: 1, cap: 1 };
const TURN: Scope = { kind: "integration" };
const CONSUMER = { kind: "model-session", id: "session-one" };
const PG_ERROR = z.object({ code: z.string(), message: z.string() });
const MAX_CAUSES = 4;
const UNOWNED_ISSUE = 3;
const DONE = /already reported done/u;
const LIVE_CONSUMER = /consumer has not reported done/u;
const LIVE_CHILD = /live resource reservations/u;
const DRAIN = /drain the pool/u;
const LOST = /ownership lost/u;
const CHANGED = /exact claim identity required/u;
const RELEASED = /released instance/u;
const UNMIGRATED = /apply migrations/u;

function binding(repo: string, issue = 1, base = "main"): Binding {
  return {
    repo,
    base,
    issue,
    branch: `agent/issue-${issue}`,
    instance: crypto.randomUUID(),
    lane: `test:${issue}`,
  };
}
function command(
  who: Binding,
  scope: Scope,
  operation: Command["operation"],
  extra: Partial<
    Pick<Command, "consumer" | "evidence" | "buddyRunId" | "task">
  > = {},
): Command {
  return {
    repo: who.repo,
    base: who.base,
    binding: who,
    scope,
    operation,
    ...extra,
  };
}
function act(
  who: Binding,
  scope: Scope,
  operation: Command["operation"],
  extra: Partial<
    Pick<Command, "consumer" | "evidence" | "buddyRunId" | "task">
  > = {},
): Promise<Result> {
  return executeCoordination(at.db, command(who, scope, operation, extra));
}
function repository(): string {
  return `tests/${crypto.randomUUID()}`;
}
async function held(
  who: Binding,
  scope: Scope,
): Promise<typeof claims.$inferSelect> {
  const view = VIEW.parse(await act(who, scope, "read"));
  if (view.owner === null) {
    throw new Error("test fixture did not acquire ownership");
  }
  const [row] = await at.db
    .select()
    .from(claims)
    .where(eq(claims.id, view.owner.id));
  if (row === undefined) {
    throw new Error("test fixture claim is missing");
  }
  return row;
}
function pgCode(error: unknown): string | undefined {
  let cause: unknown = error;
  for (let depth = 0; depth < MAX_CAUSES; depth += 1) {
    const parsed = PG_ERROR.safeParse(cause);
    if (parsed.success) {
      return parsed.data.code;
    }
    if (!(cause instanceof Error)) {
      return undefined;
    }
    ({ cause } = cause);
  }
  return undefined;
}

test("concurrent issue claims have one owner and losers leave no pending rows", async (): Promise<void> => {
  const repo = repository();
  const contenders: Binding[] = Array.from(
    { length: 4 },
    (): Binding => binding(repo),
  );
  const outcomes = await Promise.all(
    contenders.map((who): Promise<Result> => act(who, ISSUE, "claim")),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  const winner = contenders.at(outcomes.indexOf(true));
  assert.ok(winner);
  const row = await held(winner, ISSUE);
  const saved = await at.db
    .select()
    .from(claims)
    .where(eq(claims.poolId, row.poolId));
  assert.equal(saved.length, 1);
  assert.equal(await act(winner, ISSUE, "claim"), true);
  const audit = await at.db
    .select()
    .from(events)
    .where(eq(events.claimId, row.id));
  assert.deepEqual(
    audit.map((entry): string => entry.kind),
    ["acquired"],
  );
  await assert.rejects(
    act({ ...winner, lane: "changed" }, ISSUE, "assert"),
    CHANGED,
  );
});

test("issue ownership is isolated by repository, base and issue", async (): Promise<void> => {
  const first = binding(repository());
  const otherBase = binding(first.repo, 1, "integration");
  const otherIssue = binding(first.repo, 2);
  const otherRepository = binding(repository());
  assert.deepEqual(
    await Promise.all([
      act(first, ISSUE, "claim"),
      act(otherBase, ISSUE, "claim"),
      act(otherIssue, { kind: "issue", issue: 2 }, "claim"),
      act(otherRepository, ISSUE, "claim"),
    ]),
    [true, true, true, true],
  );
});

test("resource capacity cannot change until the whole pool drains", async (): Promise<void> => {
  const repo = repository();
  const first = binding(repo);
  const second = binding(repo, 2);
  await act(first, ISSUE, "claim");
  await act(second, { kind: "issue", issue: 2 }, "claim");
  const wide: Scope = { kind: "model-session", slot: 2, cap: 2 };
  assert.equal(await act(first, wide, "claim"), true);
  await assert.rejects(act(second, RESOURCE, "claim"), DRAIN);
  const row = await held(first, wide);
  const [pool] = await at.db
    .select()
    .from(pools)
    .where(eq(pools.id, row.poolId));
  assert.equal(pool?.capacity, 2);
  const [survey] = z
    .array(z.tuple([z.number(), VIEW]))
    .parse(await act(second, RESOURCE, "survey"))
    .filter(([slot]): boolean => slot === 2);
  assert.equal(survey?.[1].owner?.binding.instance, first.instance);
  await act(first, wide, "release");
  assert.equal(await act(second, RESOURCE, "claim"), true);
  const [resized] = await at.db
    .select()
    .from(pools)
    .where(eq(pools.id, row.poolId));
  assert.equal(resized?.capacity, 1);
});

test("concurrent resource contenders cannot oversubscribe one slot", async (): Promise<void> => {
  const repo = repository();
  const first = binding(repo);
  const second = binding(repo, 2);
  await Promise.all([
    act(first, ISSUE, "claim"),
    act(second, { kind: "issue", issue: 2 }, "claim"),
  ]);
  const results = await Promise.all([
    act(first, RESOURCE, "claim"),
    act(second, RESOURCE, "claim"),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const view = VIEW.parse(await act(first, RESOURCE, "read"));
  assert.equal(view.pending.length, 1);
  assert.equal(view.confirmed, true);
});

test("consumers retain resources and their issue until explicit durable completion", async (): Promise<void> => {
  const who = binding(repository());
  await act(who, ISSUE, "claim");
  await act(who, RESOURCE, "claim");
  await act(who, RESOURCE, "register", { consumer: CONSUMER });
  await act(who, RESOURCE, "register", { consumer: CONSUMER });
  await assert.rejects(act(who, RESOURCE, "release"), LIVE_CONSUMER);
  await assert.rejects(act(who, ISSUE, "release"), LIVE_CHILD);
  await act(who, RESOURCE, "done", { consumer: CONSUMER });
  await act(who, RESOURCE, "done", { consumer: CONSUMER });
  await assert.rejects(
    act(who, RESOURCE, "register", { consumer: CONSUMER }),
    DONE,
  );
  const resource = await held(who, RESOURCE);
  const audit = await at.db
    .select()
    .from(events)
    .where(eq(events.claimId, resource.id));
  assert.deepEqual(
    audit.map((entry): string => entry.kind),
    ["acquired", "registered", "done"],
  );
  await act(who, RESOURCE, "release");
  await act(who, RESOURCE, "release");
  await act(who, ISSUE, "release");
  await assert.rejects(act(who, ISSUE, "claim"), RELEASED);
});

test("integration turns serialize different issues and remain subordinate to issue execution", async (): Promise<void> => {
  const repo = repository();
  const first = binding(repo);
  const second = binding(repo, 2);
  await act(first, ISSUE, "claim");
  await act(second, { kind: "issue", issue: 2 }, "claim");
  assert.equal(await act(first, TURN, "claim"), true);
  assert.equal(await act(second, TURN, "claim"), false);
  await assert.rejects(act(first, ISSUE, "release"), LIVE_CHILD);
  await act(first, TURN, "release");
  assert.equal(await act(second, TURN, "claim"), true);
  await assert.rejects(act(binding(repo, UNOWNED_ISSUE), TURN, "read"), LOST);
});

test("fresh connections preserve ownership", async (): Promise<void> => {
  const who = binding(repository());
  await act(who, ISSUE, "claim");
  const connection = openDatabase(at.url);
  try {
    const view = VIEW.parse(
      await executeCoordination(connection.db, command(who, ISSUE, "read")),
    );
    assert.equal(view.owner?.binding.instance, who.instance);
    assert.equal(
      await executeCoordination(connection.db, command(who, ISSUE, "claim")),
      true,
    );
  } finally {
    await connection.close();
  }
});

test("a reset or separate database accepts the same commands and may disagree", async (): Promise<void> => {
  const repo = repository();
  const first = binding(repo);
  const second = binding(repo);
  await act(first, ISSUE, "claim");
  const other = await createTestDatabase();
  try {
    assert.notEqual(other.url, at.url);
    assert.equal(
      await executeCoordination(other.db, command(second, ISSUE, "claim")),
      true,
    );
    const here = VIEW.parse(await act(first, ISSUE, "read"));
    const there = VIEW.parse(
      await executeCoordination(other.db, command(second, ISSUE, "read")),
    );
    assert.equal(here.owner?.binding.instance, first.instance);
    assert.equal(there.owner?.binding.instance, second.instance);
  } finally {
    await other.close();
  }
});

test("a wiped database names its migrations, then recovers with no configuration change", async (): Promise<void> => {
  const wiped = await createTestDatabase();
  try {
    await wiped.db.execute(sql`DROP SCHEMA drizzle CASCADE`);
    await wiped.db.execute(sql`DROP SCHEMA public CASCADE`);
    await wiped.db.execute(sql`CREATE SCHEMA public`);
    const who = binding(repository());
    await assert.rejects(
      executeCoordination(wiped.db, command(who, ISSUE, "claim")),
      UNMIGRATED,
    );
    await migrate(wiped.db, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });
    assert.equal(
      await executeCoordination(wiped.db, command(who, ISSUE, "claim")),
      true,
    );
  } finally {
    await wiped.close();
  }
});

test("claims and events retain action, buddy, task, consumer and database-generated timestamps", async (): Promise<void> => {
  const who = binding(repository());
  const buddyRunId = crypto.randomUUID();
  const tracking = { buddyRunId, task: "implement" };
  await act(who, ISSUE, "claim", tracking);
  await act(who, ISSUE, "assert", tracking);
  await act(who, ISSUE, "save", {
    ...tracking,
    evidence: { outcome: "retained", action: who.instance },
  });
  await act(who, RESOURCE, "claim", tracking);
  await act(who, RESOURCE, "register", { ...tracking, consumer: CONSUMER });
  await act(who, RESOURCE, "done", { ...tracking, consumer: CONSUMER });
  const row = await held(who, ISSUE);
  const resource = await held(who, RESOURCE);
  assert.equal(resource.sourceIssueClaimId, row.id);
  assert.equal(row.buddyRunId, buddyRunId);
  assert.equal(row.task, "implement");
  assert.equal(row.instanceId, who.instance);
  assert.ok(row.createdAt instanceof Date);
  assert.ok(row.updatedAt instanceof Date);
  assert.ok(row.lastVerifiedAt instanceof Date);
  assert.ok(row.lastVerifiedAt >= row.createdAt);
  const audit = await at.db
    .select()
    .from(events)
    .where(eq(events.claimId, row.id));
  assert.deepEqual(
    audit.map((entry): string => entry.kind),
    ["acquired", "saved"],
  );
  assert.deepEqual(audit.at(1)?.evidence, {
    outcome: "retained",
    action: who.instance,
  });
  assert.equal(audit.at(1)?.actorInstanceId, who.instance);
  assert.equal(audit.at(1)?.buddyRunId, buddyRunId);
  assert.ok(audit.at(1)?.createdAt instanceof Date);
  const [consumer] = await at.db
    .select()
    .from(consumers)
    .where(eq(consumers.claimId, resource.id));
  assert.ok(consumer?.finishedAt instanceof Date);
  assert.ok(consumer.updatedAt >= consumer.createdAt);
});

test("database constraints prevent duplicate owners and claim reassignment outside the store", async (): Promise<void> => {
  const who = binding(repository());
  await act(who, ISSUE, "claim");
  const row = await held(who, ISSUE);
  await assert.rejects(
    at.db.insert(claims).values({
      poolId: row.poolId,
      kind: "issue",
      instanceId: crypto.randomUUID(),
      lane: "direct",
      issueNumber: 1,
      branch: row.branch,
      slot: 1,
      declaredCapacity: 1,
    }),
    (error: unknown): boolean => pgCode(error) === "23505",
  );
  await assert.rejects(
    at.db
      .update(claims)
      .set({ branch: "different" })
      .where(eq(claims.id, row.id)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
  const owners = await at.db
    .select()
    .from(claims)
    .where(and(eq(claims.poolId, row.poolId), isNull(claims.releasedAt)));
  assert.equal(owners.length, 1);
});

test("database lifecycle guards protect consumers, pool capacity, history and released claims", async (): Promise<void> => {
  const who = binding(repository());
  await act(who, ISSUE, "claim");
  await act(who, RESOURCE, "claim");
  await act(who, RESOURCE, "register", { consumer: CONSUMER });
  const row = await held(who, RESOURCE);
  await assert.rejects(
    at.db
      .update(claims)
      .set({ releasedAt: sql`clock_timestamp()` })
      .where(eq(claims.id, row.id)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
  await assert.rejects(
    at.db.update(pools).set({ capacity: 2 }).where(eq(pools.id, row.poolId)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
  await act(who, RESOURCE, "done", { consumer: CONSUMER });
  await assert.rejects(
    at.db
      .update(consumers)
      .set({ finishedAt: null })
      .where(eq(consumers.claimId, row.id)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
  await act(who, RESOURCE, "release");
  await assert.rejects(
    at.db.update(claims).set({ releasedAt: null }).where(eq(claims.id, row.id)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
  await assert.rejects(
    at.db
      .update(events)
      .set({ reason: "rewritten" })
      .where(eq(events.claimId, row.id)),
    (error: unknown): boolean => pgCode(error) === "P0001",
  );
});

test("migrations can run again without replacing retained ownership", async (): Promise<void> => {
  const who = binding(repository());
  await act(who, ISSUE, "claim");
  await migrate(at.db, {
    migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
  });
  assert.equal(
    VIEW.parse(await act(who, ISSUE, "read")).owner?.binding.instance,
    who.instance,
  );
});
