import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";
import { sql } from "drizzle-orm";
import { openDatabase } from "../../src/client.ts";
import {
  appendBatch,
  cursor,
  readSnapshot,
  saveEntity,
  transcript,
} from "../../src/monitoring.ts";
import type {
  MonitorEntity,
  MonitorEvent,
} from "../../src/monitoring-protocol.ts";
import { monitorEntities } from "../../src/tables/monitoring.ts";
import {
  createTestDatabase,
  type TestDatabase,
} from "../support/test-database.ts";

const expected = {
  input: 100,
  firstContext: 150,
  latestContext: 80,
  totalInput: 210,
  totalOutput: 35,
  window: 272_000,
  pageSize: 100,
  policyPosition: 3,
};
const at: TestDatabase = await createTestDatabase();
after(async (): Promise<void> => {
  await at.close();
});
const time = "2026-10-28T12:00:00.000Z";
function entity(
  id: string,
  kind: MonitorEntity["kind"] = "session",
  repo: string | null = "tests/one",
): MonitorEntity {
  return {
    id,
    kind,
    repo,
    issue: 1,
    parent: null,
    title: "Work",
    state: "running",
    task: "implement",
    phase: null,
    actor: "Developer",
    model: "test/model",
    window: null,
    startedAt: time,
    endedAt: null,
    activityAt: time,
    sourceAt: time,
    reason: null,
  };
}
function event(
  source: string,
  session: string,
  position: number,
): MonitorEvent {
  return {
    source,
    session,
    position,
    kind: "message",
    at: time,
    label: "assistant",
    body: "A response",
    reasoning: "Exposed reasoning",
    usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10 },
    context: 150,
    window: null,
    target: null,
    compacted: false,
  };
}

test("replayed and competing batches cannot duplicate messages or tokens", async (): Promise<void> => {
  const source = "replay";
  const session = "replayed-session";
  await saveEntity(at.db, entity(session));
  const batch = {
    source,
    offset: 0,
    next: 1,
    events: [event(source, session, 0)],
  };
  const outcomes = await Promise.allSettled([
    appendBatch(at.db, batch),
    appendBatch(at.db, batch),
  ]);
  assert.equal(
    outcomes.filter((result): boolean => result.status === "fulfilled").length,
    1,
  );
  await assert.rejects(appendBatch(at.db, batch));
  assert.equal(await cursor(at.db, source), 1);
  const snapshot = await readSnapshot(at.db, ["tests/one"]);
  const usage = snapshot.usage.find((row): boolean => row.session === session);
  assert.equal(usage?.input, expected.input);
  assert.equal(usage?.latest, expected.firstContext);
  assert.equal(usage?.turns, 1);
  assert.equal((await transcript(at.db, session)).rows.length, 1);
});

test("context can shrink after compaction while lifetime usage still increases", async (): Promise<void> => {
  const source = "compact";
  const session = "compacted-session";
  await saveEntity(at.db, entity(session));
  const first = event(source, session, 0);
  const compact: MonitorEvent = {
    ...event(source, session, 1),
    kind: "compaction",
    context: null,
    usage: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 },
    compacted: true,
  };
  const last: MonitorEvent = {
    ...event(source, session, 2),
    context: 80,
    usage: { input: 80, output: 10, cacheRead: 0, cacheWrite: 0 },
  };
  const policy: MonitorEvent = {
    ...event(source, session, expected.policyPosition),
    kind: "policy",
    context: null,
    usage: null,
    window: 272_000,
    target: 175_000,
  };
  await appendBatch(at.db, {
    source,
    offset: 0,
    next: 4,
    events: [first, compact, last, policy],
  });
  const usage = (await readSnapshot(at.db, ["tests/one"])).usage.find(
    (row): boolean => row.session === session,
  );
  assert.equal(usage?.first, expected.firstContext);
  assert.equal(usage?.peak, expected.firstContext);
  assert.equal(usage?.latest, expected.latestContext);
  assert.equal(usage?.input, expected.totalInput);
  assert.equal(usage?.output, expected.totalOutput);
  assert.equal(usage?.compactions, 1);
  assert.equal(usage?.turns, 2);
  assert.equal(usage?.window, expected.window);
});

test("an unmeasured session has no invented zero usage and repository filters isolate work", async (): Promise<void> => {
  await saveEntity(at.db, entity("empty"));
  await saveEntity(at.db, entity("other", "session", "tests/two"));
  const snapshot = await readSnapshot(at.db, ["tests/one"]);
  assert.ok(snapshot.entities.some((row): boolean => row.id === "empty"));
  assert.ok(!snapshot.entities.some((row): boolean => row.id === "other"));
  assert.equal(
    snapshot.usage.find((row): boolean => row.session === "empty"),
    undefined,
  );
});

test("older snapshots cannot overwrite current outcomes", async (): Promise<void> => {
  const latest = {
    ...entity("outcome", "action"),
    sourceAt: "2026-10-28T13:00:00.000Z",
    state: "succeeded",
  };
  await saveEntity(at.db, latest);
  await saveEntity(at.db, entity("outcome", "action"));
  const snapshot = await readSnapshot(at.db, ["tests/one"]);
  assert.equal(
    snapshot.entities.find((row): boolean => row.id === latest.id)?.state,
    "succeeded",
  );
});

test("transcript pages are bounded and retain access to every earlier event", async (): Promise<void> => {
  const source = "pages";
  const session = "paged-session";
  const events = Array.from(
    { length: 205 },
    (_, index): MonitorEvent => event(source, session, index),
  );
  await appendBatch(at.db, { source, offset: 0, next: events.length, events });
  const last = await transcript(at.db, session);
  assert.equal(last.rows.length, expected.pageSize);
  assert.equal(last.more, true);
  const middle = await transcript(at.db, session, last.rows.at(0)?.sequence);
  const first = await transcript(at.db, session, middle.rows.at(0)?.sequence);
  assert.equal(first.more, false);
  const positions = [...first.rows, ...middle.rows, ...last.rows].map(
    (row): number => row.event.position,
  );
  assert.deepEqual(
    positions,
    Array.from({ length: events.length }, (_, index): number => index),
  );
});

test("read-only transactions prevent writes even through a privileged connection", async (): Promise<void> => {
  await assert.rejects(
    at.db.transaction(async (tx): Promise<void> => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.delete(monitorEntities);
    }),
  );
  assert.ok((await readSnapshot(at.db, ["tests/one"])).entities.length > 0);
});

test("a database reader can inspect monitoring but cannot write it", async (): Promise<void> => {
  const role = `monitor_reader_${crypto.randomUUID().replaceAll("-", "")}`;
  await at.db.execute(
    sql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD 'fixture'`),
  );
  const url = new URL(at.url);
  url.username = role;
  url.password = "fixture";
  const reader = openDatabase(url.href);
  try {
    await at.db.execute(
      sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`,
    );
    await at.db.execute(
      sql`GRANT SELECT ON monitor_entities, monitor_events TO ${sql.identifier(role)}`,
    );
    assert.ok(
      (await readSnapshot(reader.db, ["tests/one"])).entities.length > 0,
    );
    assert.equal(
      (await transcript(reader.db, "replayed-session")).rows.length,
      1,
    );
    await assert.rejects(saveEntity(reader.db, entity("unauthorized")));
  } finally {
    await reader.close();
    await at.db.execute(sql`DROP OWNED BY ${sql.identifier(role)}`);
    await at.db.execute(sql`DROP ROLE ${sql.identifier(role)}`);
  }
});
