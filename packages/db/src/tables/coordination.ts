import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Evidence } from "../protocol.ts";

const scopeKind = pgEnum("coordination_scope_kind", [
  "issue",
  "integration",
  "model-session",
]);
const eventKind = pgEnum("coordination_event_kind", [
  "acquired",
  "released",
  "saved",
  "registered",
  "done",
]);

const repositories = pgTable(
  "coordination_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repository: text("repository").notNull(),
    baseBranch: text("base_branch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique("coordination_repository_base").on(
      table.repository,
      table.baseBranch,
    ),
    check(
      "coordination_repository_present",
      sql`length(${table.repository}) > 0 AND length(${table.baseBranch}) > 0`,
    ),
  ],
);

// A pool is one issue's execution, one target's integration turn, or the
// target's model-session slots. Issue/integration capacity is always one.
const pools = pgTable(
  "coordination_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id),
    kind: scopeKind("kind").notNull(),
    issueNumber: integer("issue_number").notNull().default(0),
    capacity: integer("capacity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique("coordination_pool_scope").on(
      table.repositoryId,
      table.kind,
      table.issueNumber,
    ),
    unique("coordination_pool_kind").on(table.id, table.kind),
    check(
      "coordination_pool_issue",
      sql`(${table.kind} = 'issue' AND ${table.issueNumber} > 0) OR (${table.kind} <> 'issue' AND ${table.issueNumber} = 0)`,
    ),
    check(
      "coordination_pool_capacity",
      sql`${table.capacity} > 0 AND (${table.kind} = 'model-session' OR ${table.capacity} = 1)`,
    ),
  ],
);

// A row exists only after acquisition commits. released_at is the complete
// lifecycle: NULL means held. There is no separate status that can disagree
// with timestamps, no pending claim and no confirmation/epoch token.
const claims = pgTable(
  "coordination_claims",
  {
    id: serial("id").primaryKey(),
    poolId: uuid("pool_id").notNull(),
    kind: scopeKind("kind").notNull(),
    sourceIssueClaimId: integer("source_issue_claim_id").references(
      (): AnyPgColumn => claims.id,
    ),
    instanceId: uuid("instance_id").notNull(),
    lane: text("lane").notNull(),
    issueNumber: integer("issue_number").notNull(),
    branch: text("branch").notNull(),
    buddyRunId: uuid("buddy_run_id"),
    task: text("task"),
    slot: integer("slot").notNull(),
    declaredCapacity: integer("declared_capacity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    foreignKey({
      columns: [table.poolId, table.kind],
      foreignColumns: [pools.id, pools.kind],
      name: "coordination_claim_pool",
    }),
    unique("coordination_claim_invocation").on(table.poolId, table.instanceId),
    uniqueIndex("coordination_one_slot_owner")
      .on(table.poolId, table.slot)
      .where(sql`${table.releasedAt} IS NULL`),
    index("coordination_claim_source").on(table.sourceIssueClaimId),
    index("coordination_claim_buddy").on(table.buddyRunId),
    index("coordination_claim_verification")
      .on(table.lastVerifiedAt)
      .where(sql`${table.releasedAt} IS NULL`),
    check(
      "coordination_claim_identity",
      sql`${table.issueNumber} > 0 AND length(${table.lane}) > 0 AND length(${table.branch}) > 0`,
    ),
    check(
      "coordination_claim_source_kind",
      sql`(${table.kind} = 'issue' AND ${table.sourceIssueClaimId} IS NULL) OR (${table.kind} <> 'issue' AND ${table.sourceIssueClaimId} IS NOT NULL)`,
    ),
    check(
      "coordination_claim_slot",
      sql`${table.slot} > 0 AND ${table.slot} <= ${table.declaredCapacity} AND (${table.kind} = 'model-session' OR (${table.slot} = 1 AND ${table.declaredCapacity} = 1))`,
    ),
  ],
);

const consumers = pgTable(
  "coordination_consumers",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => claims.id),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("coordination_consumer_identity").on(
      table.claimId,
      table.kind,
      table.externalId,
    ),
    check(
      "coordination_consumer_present",
      sql`length(${table.kind}) > 0 AND length(${table.externalId}) > 0`,
    ),
    index("coordination_consumer_live")
      .on(table.claimId)
      .where(sql`${table.finishedAt} IS NULL`),
  ],
);

// Events explain committed transitions. Ownership comes from constrained
// claims, never from replaying this audit history. JSON is evidence only.
const events = pgTable(
  "coordination_events",
  {
    id: serial("id").primaryKey(),
    claimId: integer("claim_id")
      .notNull()
      .references(() => claims.id),
    kind: eventKind("kind").notNull(),
    actorInstanceId: uuid("actor_instance_id").notNull(),
    buddyRunId: uuid("buddy_run_id"),
    task: text("task"),
    consumerId: integer("consumer_id").references(() => consumers.id),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Evidence>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("coordination_event_claim").on(table.claimId, table.id),
    index("coordination_event_created").on(table.createdAt),
    check("coordination_event_reason", sql`length(${table.reason}) > 0`),
    check(
      "coordination_event_consumer",
      sql`(${table.kind} IN ('registered', 'done')) = (${table.consumerId} IS NOT NULL)`,
    ),
  ],
);

export { claims, consumers, eventKind, events, pools, repositories, scopeKind };
