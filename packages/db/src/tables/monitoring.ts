import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { MonitorEntity, MonitorEvent } from "../monitoring-protocol.ts";

// Monitoring has no foreign keys or cascade into operational coordination.
const monitorEntities = pgTable(
  "monitor_entities",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    repo: text("repo"),
    parent: text("parent"),
    sourceAt: timestamp("source_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    data: jsonb("data").$type<MonitorEntity>().notNull(),
  },
  (table) => [
    index("monitor_entity_scope").on(table.kind, table.repo),
    index("monitor_entity_parent").on(table.parent),
  ],
);
const monitorEvents = pgTable(
  "monitor_events",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    session: text("session").notNull(),
    source: text("source").notNull(),
    position: bigint("position", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    input: bigint("input", { mode: "number" }),
    output: bigint("output", { mode: "number" }),
    cacheRead: bigint("cache_read", { mode: "number" }),
    cacheWrite: bigint("cache_write", { mode: "number" }),
    context: bigint("context", { mode: "number" }),
    window: integer("context_window"),
    target: integer("compaction_target"),
    compacted: boolean("compacted").notNull(),
    data: jsonb("data").$type<MonitorEvent>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique("monitor_source_position").on(table.source, table.position),
    index("monitor_event_session").on(table.session, table.sequence),
  ],
);
const monitorCursors = pgTable("monitor_cursors", {
  source: text("source").primaryKey(),
  offset: bigint("offset", { mode: "number" }).notNull(),
});

export { monitorCursors, monitorEntities, monitorEvents };
