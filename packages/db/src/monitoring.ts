import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  batchSchema,
  entitySchema,
  eventSchema,
  type MonitorBatch,
  type MonitorEntity,
  type MonitorEvent,
} from "./monitoring-protocol.ts";
import {
  monitorCursors,
  monitorEntities,
  monitorEvents,
} from "./tables/monitoring.ts";

interface UsageSummary {
  session: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  peak: number | null;
  first: number | null;
  latest: number | null;
  window: number | null;
  target: number | null;
  lastActivity: string | null;
  turns: number;
  compactions: number;
}
interface MonitorSnapshot {
  entities: MonitorEntity[];
  usage: UsageSummary[];
  at: string;
  partial: boolean;
}
interface TranscriptRow {
  sequence: number;
  event: MonitorEvent;
}
interface TranscriptPage {
  rows: TranscriptRow[];
  more: boolean;
}
const snapshotLimit = 1000;
const pageLimit = 100;

async function saveEntity(db: Database, input: MonitorEntity): Promise<void> {
  const data = entitySchema.parse(input);
  await db
    .insert(monitorEntities)
    .values({
      id: data.id,
      kind: data.kind,
      repo: data.repo,
      parent: data.parent,
      sourceAt: new Date(data.sourceAt),
      data,
    })
    .onConflictDoUpdate({
      target: monitorEntities.id,
      set: {
        sourceAt: new Date(data.sourceAt),
        data,
        kind: data.kind,
        repo: data.repo,
        parent: data.parent,
        receivedAt: sql`clock_timestamp()`,
      },
      setWhere: sql`${monitorEntities.sourceAt} <= ${new Date(data.sourceAt)}`,
    });
}
async function cursor(db: Database, source: string): Promise<number> {
  const [row] = await db
    .select()
    .from(monitorCursors)
    .where(eq(monitorCursors.source, source));
  return row?.offset ?? 0;
}
// Cursor and events commit together; replay and competing collectors cannot add usage twice.
async function appendBatch(db: Database, input: MonitorBatch): Promise<void> {
  const batch = batchSchema.parse(input);
  await db.transaction(async (tx): Promise<void> => {
    await tx
      .insert(monitorCursors)
      .values({ source: batch.source, offset: 0 })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(monitorCursors)
      .where(eq(monitorCursors.source, batch.source))
      .for("update");
    if (row?.offset !== batch.offset) {
      throw new Error(
        "Monitoring cursor changed; reread the source before continuing",
      );
    }
    if (batch.events.length > 0) {
      await tx
        .insert(monitorEvents)
        .values(
          batch.events.map((data) => ({
            session: data.session,
            source: data.source,
            position: data.position,
            kind: data.kind,
            input: data.usage?.input,
            output: data.usage?.output,
            cacheRead: data.usage?.cacheRead,
            cacheWrite: data.usage?.cacheWrite,
            context: data.context,
            window: data.window,
            target: data.target,
            compacted: data.compacted,
            data,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(monitorCursors)
      .set({ offset: batch.next })
      .where(eq(monitorCursors.source, batch.source));
  });
}
function numericSum(column: SQLWrapper): ReturnType<typeof sql<number | null>> {
  return sql<number | null>`sum(${column})`.mapWith({
    mapFromDriverValue: (value: string): number => Number(value),
  });
}
function readSnapshot(
  db: Database,
  repositories: string[],
): Promise<MonitorSnapshot> {
  return db.transaction(async (tx): Promise<MonitorSnapshot> => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const rows = await tx
      .select()
      .from(monitorEntities)
      .where(
        sql`(${monitorEntities.repo} IS NULL OR ${inArray(monitorEntities.repo, repositories)})`,
      )
      .orderBy(desc(monitorEntities.sourceAt), asc(monitorEntities.id))
      .limit(snapshotLimit + 1);
    const entities = rows
      .slice(0, snapshotLimit)
      .map((row): MonitorEntity => entitySchema.parse(row.data));
    const sessions = entities
      .filter((entity): boolean => entity.kind === "session")
      .map((entity): string => entity.id);
    let usage: UsageSummary[] = [];
    if (sessions.length > 0) {
      usage = await tx
        .select({
          session: monitorEvents.session,
          input: numericSum(monitorEvents.input),
          output: numericSum(monitorEvents.output),
          cacheRead: numericSum(monitorEvents.cacheRead),
          cacheWrite: numericSum(monitorEvents.cacheWrite),
          peak: sql<number | null>`max(${monitorEvents.context})`.mapWith(
            Number,
          ),
          first: sql<
            number | null
          >`(array_agg(${monitorEvents.context} order by ${monitorEvents.sequence}) filter (where ${monitorEvents.context} is not null))[1]`.mapWith(
            Number,
          ),
          latest: sql<
            number | null
          >`(array_agg(${monitorEvents.context} order by ${monitorEvents.sequence} desc) filter (where ${monitorEvents.context} is not null))[1]`.mapWith(
            Number,
          ),
          window: sql<number | null>`max(${monitorEvents.window})`.mapWith(
            Number,
          ),
          target: sql<number | null>`max(${monitorEvents.target})`.mapWith(
            Number,
          ),
          lastActivity: sql<string | null>`max(${monitorEvents.data}->>'at')`,
          turns: sql<number>`count(${monitorEvents.context})`.mapWith(Number),
          compactions:
            sql<number>`count(*) filter (where ${monitorEvents.compacted})`.mapWith(
              Number,
            ),
        })
        .from(monitorEvents)
        .where(inArray(monitorEvents.session, sessions))
        .groupBy(monitorEvents.session);
    }
    return {
      entities,
      usage,
      at: new Date().toISOString(),
      partial: rows.length > snapshotLimit,
    };
  });
}
function transcript(
  db: Database,
  session: string,
  before?: number,
): Promise<TranscriptPage> {
  return db.transaction(async (tx): Promise<TranscriptPage> => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    let condition = eq(monitorEvents.session, session);
    if (before !== undefined) {
      condition =
        and(condition, lt(monitorEvents.sequence, before)) ?? condition;
    }
    const rows = await tx
      .select()
      .from(monitorEvents)
      .where(condition)
      .orderBy(desc(monitorEvents.sequence))
      .limit(pageLimit + 1);
    return {
      more: rows.length > pageLimit,
      rows: rows
        .slice(0, pageLimit)
        .reverse()
        .map(
          (row): TranscriptRow => ({
            sequence: row.sequence,
            event: eventSchema.parse(row.data),
          }),
        ),
    };
  });
}
function sessionMetrics(
  db: Database,
  session: string,
): Promise<{
  first: MonitorEvent | null;
  latest: MonitorEvent | null;
  policy: MonitorEvent | null;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const measured = and(
      eq(monitorEvents.session, session),
      gt(monitorEvents.context, -1),
    );
    const [first] = await tx
      .select()
      .from(monitorEvents)
      .where(measured)
      .orderBy(asc(monitorEvents.sequence))
      .limit(1);
    const [latest] = await tx
      .select()
      .from(monitorEvents)
      .where(measured)
      .orderBy(desc(monitorEvents.sequence))
      .limit(1);
    const [policy] = await tx
      .select()
      .from(monitorEvents)
      .where(
        and(
          eq(monitorEvents.session, session),
          eq(monitorEvents.kind, "policy"),
        ),
      )
      .orderBy(desc(monitorEvents.sequence))
      .limit(1);
    return {
      first: first?.data ?? null,
      latest: latest?.data ?? null,
      policy: policy?.data ?? null,
    };
  });
}

export type { MonitorSnapshot, TranscriptPage, TranscriptRow, UsageSummary };
export {
  appendBatch,
  cursor,
  readSnapshot,
  saveEntity,
  sessionMetrics,
  transcript,
};
