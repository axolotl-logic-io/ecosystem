import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.ts";
import type { Binding, Claim, Command, Result, View } from "./protocol.ts";
import { COMMAND } from "./protocol.ts";
import {
  claims,
  consumers,
  events,
  pools,
  repositories,
} from "./tables/coordination.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ClaimRow = typeof claims.$inferSelect;
type PoolRow = typeof pools.$inferSelect;
type Event = Pick<typeof events.$inferInsert, "kind" | "reason" | "consumerId">;
const NOW: SQL = sql`clock_timestamp()`;
const MAX_ERROR_CAUSES = 4;
const UNDEFINED_TABLE = "42P01";
const DATABASE_ERROR = z.object({ code: z.string(), message: z.string() });
const DATABASE_REASONS: ReadonlyMap<string, string> = new Map([
  [
    "coordination_capacity_live",
    "live claims declare another capacity; drain the pool before resizing",
  ],
  ["coordination_capacity_mismatch", "claim capacity differs from the pool"],
  [
    "coordination_source_mismatch",
    "issue execution ownership lost or binding changed",
  ],
  [
    "coordination_consumers_live",
    "a registered consumer has not reported done",
  ],
  [
    "coordination_children_live",
    "issue execution still has live resource reservations",
  ],
  [
    "coordination_consumer_not_owned",
    "only a held resource slot has consumers",
  ],
  ["coordination_completion_immutable", "consumer completion cannot be undone"],
  [
    "coordination_consumer_not_registered",
    "consumer must be registered before reporting done",
  ],
  ["coordination_release_immutable", "released ownership cannot be reopened"],
  ["coordination_new_claim_released", "a new claim must be live"],
  ["coordination_identity_immutable", "coordination identity cannot change"],
  [
    "coordination_history_immutable",
    "coordination history cannot be changed or deleted",
  ],
]);

function databaseFailure(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSES; depth += 1) {
    const parsed = DATABASE_ERROR.safeParse(cause);
    if (parsed.success && parsed.data.code === UNDEFINED_TABLE) {
      // The transaction failed before it wrote anything, so this is
      // determined: a new or reset database that needs its migrations.
      throw new CoordinationError(
        "the database has no coordination tables; apply migrations with npm run db:migrate",
      );
    }
    if (parsed.success && parsed.data.code === "P0001") {
      const reason = DATABASE_REASONS.get(parsed.data.message);
      if (reason !== undefined) {
        throw new CoordinationError(reason);
      }
    }
    if (!(cause instanceof Error)) {
      break;
    }
    ({ cause } = cause);
  }
  throw error;
}

class CoordinationError extends Error {}
function requireCondition(
  condition: boolean,
  reason: string,
): asserts condition {
  if (!condition) {
    throw new CoordinationError(reason);
  }
}
function bindingOf(command: Command): Binding {
  const { binding } = command;
  requireCondition(
    binding !== undefined,
    "this operation needs an execution binding",
  );
  requireCondition(
    binding.repo === command.repo && binding.base === command.base,
    "execution repository/base changed",
  );
  if (command.scope.kind === "issue") {
    requireCondition(
      binding.issue === command.scope.issue,
      "execution issue changed",
    );
  }
  return binding;
}
function exactBinding(row: ClaimRow, binding: Binding): boolean {
  return (
    row.instanceId === binding.instance &&
    row.lane === binding.lane &&
    row.issueNumber === binding.issue &&
    row.branch === binding.branch
  );
}
function slotOf(command: Command): number {
  if (command.scope.kind === "model-session") {
    return command.scope.slot;
  }
  return 1;
}
function capOf(command: Command): number {
  if (command.scope.kind === "model-session") {
    return command.scope.cap;
  }
  return 1;
}

// Serialize a repository/base's source checks and transitions. The database
// also takes this lock for direct writes through its integrity triggers.
async function lockRepository(
  tx: Transaction,
  command: Command,
): Promise<string> {
  await tx
    .insert(repositories)
    .values({ repository: command.repo, baseBranch: command.base })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.repository, command.repo),
        eq(repositories.baseBranch, command.base),
      ),
    )
    .for("update");
  requireCondition(row !== undefined, "repository disappeared");
  return row.id;
}
async function poolOf(
  tx: Transaction,
  command: Command,
  repositoryId: string,
): Promise<PoolRow | undefined> {
  let issueNumber = 0;
  if (command.scope.kind === "issue") {
    issueNumber = command.scope.issue;
  }
  const where = and(
    eq(pools.repositoryId, repositoryId),
    eq(pools.kind, command.scope.kind),
    eq(pools.issueNumber, issueNumber),
  );
  if (command.operation === "claim") {
    await tx
      .insert(pools)
      .values({
        repositoryId,
        kind: command.scope.kind,
        issueNumber,
        capacity: capOf(command),
      })
      .onConflictDoNothing();
  }
  const [pool] = await tx.select().from(pools).where(where);
  if (
    pool !== undefined &&
    pool.capacity !== capOf(command) &&
    command.operation === "claim"
  ) {
    // The database rejects this update while any claim in the pool is live.
    const [resized] = await tx
      .update(pools)
      .set({ capacity: capOf(command), updatedAt: NOW })
      .where(eq(pools.id, pool.id))
      .returning();
    return resized;
  }
  return pool;
}
async function sourceExecution(
  tx: Transaction,
  command: Command,
  repositoryId: string,
): Promise<number | null> {
  if (command.scope.kind === "issue") {
    return null;
  }
  const binding = bindingOf(command);
  const [source] = await tx
    .select({ claim: claims })
    .from(claims)
    .innerJoin(pools, eq(claims.poolId, pools.id))
    .where(
      and(
        eq(pools.repositoryId, repositoryId),
        eq(pools.kind, "issue"),
        eq(pools.issueNumber, binding.issue),
        isNull(claims.releasedAt),
      ),
    );
  requireCondition(
    source !== undefined && exactBinding(source.claim, binding),
    "issue execution ownership lost or unconfirmed",
  );
  return source.claim.id;
}
function publicClaim(command: Command, row: ClaimRow): Claim {
  const claim: Claim = {
    id: row.id,
    binding: {
      repo: command.repo,
      base: command.base,
      instance: row.instanceId,
      lane: row.lane,
      issue: row.issueNumber,
      branch: row.branch,
    },
  };
  if (row.kind === "model-session") {
    claim.cap = row.declaredCapacity;
  }
  return claim;
}
// Authority reads need live owners and this caller's terminal receipt, not
// a scan of every action ever recorded in the pool. Audit history is separate.
function relevantClaims(command: Command): SQL {
  if (command.binding === undefined) {
    return isNull(claims.releasedAt);
  }
  return sql`(${claims.releasedAt} IS NULL OR ${claims.instanceId} = ${command.binding.instance})`;
}
async function viewOf(
  tx: Transaction,
  command: Command,
  pool: PoolRow | undefined,
  slot: number,
): Promise<View> {
  const rows: ClaimRow[] = [];
  if (pool !== undefined) {
    rows.push(
      ...(await tx
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.poolId, pool.id),
            eq(claims.slot, slot),
            relevantClaims(command),
          ),
        )
        .orderBy(asc(claims.id))),
    );
  }
  const owner = rows.find((row): boolean => row.releasedAt === null);
  const registered: View["consumers"] = [];
  if (owner !== undefined) {
    const saved = await tx
      .select()
      .from(consumers)
      .where(eq(consumers.claimId, owner.id))
      .orderBy(asc(consumers.id));
    registered.push(
      ...saved.map((row) => ({
        consumer: { kind: row.kind, id: row.externalId },
        done: row.finishedAt !== null,
      })),
    );
  }
  let ownerClaim: Claim | null = null;
  const pending: Claim[] = [];
  if (owner !== undefined) {
    ownerClaim = publicClaim(command, owner);
    pending.push(ownerClaim);
  }
  return {
    owner: ownerClaim,
    confirmed: owner !== undefined,
    pending,
    consumers: registered,
    requestedInstances: rows.map((row): string => row.instanceId),
    releasedInstances: rows
      .filter((row): boolean => row.releasedAt !== null)
      .map((row): string => row.instanceId),
  };
}
async function ownRow(
  tx: Transaction,
  command: Command,
  pool: PoolRow | undefined,
): Promise<ClaimRow> {
  const binding = bindingOf(command);
  requireCondition(pool !== undefined, "claim is missing");
  const found = await tx
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.poolId, pool.id),
        eq(claims.slot, slotOf(command)),
        eq(claims.instanceId, binding.instance),
      ),
    );
  const row: ClaimRow | undefined = found.at(0);
  requireCondition(
    row !== undefined && exactBinding(row, binding),
    "exact claim identity required",
  );
  return row;
}
async function audit(
  tx: Transaction,
  command: Command,
  row: ClaimRow,
  event: Event,
): Promise<void> {
  await tx.insert(events).values({
    ...event,
    claimId: row.id,
    actorInstanceId: bindingOf(command).instance,
    buddyRunId: command.buddyRunId,
    task: command.task,
    evidence: command.evidence,
  });
}
async function acquireClaim(
  tx: Transaction,
  command: Command,
  pool: PoolRow | undefined,
  sourceIssueClaimId: number | null,
): Promise<boolean> {
  const binding = bindingOf(command);
  requireCondition(pool !== undefined, "pool is missing");
  const [previous] = await tx
    .select()
    .from(claims)
    .where(
      and(eq(claims.poolId, pool.id), eq(claims.instanceId, binding.instance)),
    );
  if (previous !== undefined) {
    requireCondition(
      exactBinding(previous, binding) && previous.slot === slotOf(command),
      "instance identity or slot changed",
    );
    requireCondition(
      previous.releasedAt === null,
      "released instance cannot acquire again",
    );
    return true;
  }
  const [owner] = await tx
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(
        eq(claims.poolId, pool.id),
        eq(claims.slot, slotOf(command)),
        isNull(claims.releasedAt),
      ),
    );
  if (owner !== undefined) {
    return false;
  }
  const [row] = await tx
    .insert(claims)
    .values({
      poolId: pool.id,
      kind: pool.kind,
      sourceIssueClaimId,
      instanceId: binding.instance,
      lane: binding.lane,
      issueNumber: binding.issue,
      branch: binding.branch,
      buddyRunId: command.buddyRunId,
      task: command.task,
      slot: slotOf(command),
      declaredCapacity: capOf(command),
    })
    .returning();
  requireCondition(row !== undefined, "claim was not stored");
  await audit(tx, command, row, {
    kind: "acquired",
    reason: "execution acquired this slot atomically",
  });
  return true;
}
async function release(
  tx: Transaction,
  command: Command,
  row: ClaimRow,
): Promise<void> {
  if (row.releasedAt !== null) {
    return;
  }
  // Integrity triggers reject unfinished consumers and live child claims.
  await tx
    .update(claims)
    .set({ releasedAt: NOW, updatedAt: NOW })
    .where(eq(claims.id, row.id));
  await audit(tx, command, row, {
    kind: "released",
    reason: "holder explicitly released the scope after consumers completed",
  });
}
async function report(
  tx: Transaction,
  command: Command,
  row: ClaimRow,
): Promise<void> {
  const { consumer } = command;
  requireCondition(consumer !== undefined, "consumer identity is required");
  const [existing] = await tx
    .select()
    .from(consumers)
    .where(
      and(
        eq(consumers.claimId, row.id),
        eq(consumers.kind, consumer.kind),
        eq(consumers.externalId, consumer.id),
      ),
    );
  if (command.operation === "done") {
    requireCondition(existing !== undefined, "consumer was never registered");
    if (existing.finishedAt !== null) {
      return;
    }
    await tx
      .update(consumers)
      .set({ finishedAt: NOW, updatedAt: NOW })
      .where(eq(consumers.id, existing.id));
    await audit(tx, command, row, {
      kind: "done",
      reason: "holder confirmed the registered consumer finished",
      consumerId: existing.id,
    });
    return;
  }
  if (existing !== undefined) {
    requireCondition(
      existing.finishedAt === null,
      "consumer already reported done; register a new consumer",
    );
    return;
  }
  const [saved] = await tx
    .insert(consumers)
    .values({ claimId: row.id, kind: consumer.kind, externalId: consumer.id })
    .returning();
  requireCondition(saved !== undefined, "consumer was not stored");
  await audit(tx, command, row, {
    kind: "registered",
    reason: "holder registered the consumer before starting it",
    consumerId: saved.id,
  });
}
async function survey(
  tx: Transaction,
  command: Command,
  pool: PoolRow | undefined,
): Promise<[number, View][]> {
  requireCondition(
    command.scope.kind === "model-session",
    "only a resource pool has slots to survey",
  );
  const slots = new Set<number>();
  for (let slot = 1; slot <= command.scope.cap; slot += 1) {
    slots.add(slot);
  }
  if (pool !== undefined) {
    const historical = await tx
      .selectDistinct({ slot: claims.slot })
      .from(claims)
      .where(and(eq(claims.poolId, pool.id), relevantClaims(command)));
    for (const row of historical) {
      slots.add(row.slot);
    }
  }
  return Promise.all(
    [...slots]
      .sort((a: number, b: number): number => a - b)
      .map(
        async (slot: number): Promise<[number, View]> => [
          slot,
          await viewOf(tx, command, pool, slot),
        ],
      ),
  );
}

// One claim is one transaction, including its source ownership, capacity
// and audit event. Losing contenders leave no row to cancel. No automatic
// retry spends a cause or replays a GitHub effect; reconnecting callers
// observe the same invocation. Expiry and process exit grant nothing.
//
// These rows are short-term operational state for the database they live
// in. Another database, or this one after a reset, may disagree; callers
// keep durable work and write safeguards outside it.
function executeCoordination(db: Database, input: unknown): Promise<Result> {
  const command = COMMAND.parse(input);
  return db
    .transaction(async (tx: Transaction): Promise<Result> => {
      const repositoryId = await lockRepository(tx, command);
      const source = await sourceExecution(tx, command, repositoryId);
      const pool = await poolOf(tx, command, repositoryId);
      if (command.operation === "read") {
        return viewOf(tx, command, pool, slotOf(command));
      }
      if (command.operation === "survey") {
        return survey(tx, command, pool);
      }
      if (command.operation === "claim") {
        return acquireClaim(tx, command, pool, source);
      }
      const row = await ownRow(tx, command, pool);
      if (command.operation === "release") {
        await release(tx, command, row);
        return null;
      }
      requireCondition(
        row.releasedAt === null,
        "execution ownership lost or unconfirmed",
      );
      if (command.operation === "assert") {
        await tx
          .update(claims)
          .set({ lastVerifiedAt: NOW })
          .where(eq(claims.id, row.id));
        return null;
      }
      if (command.operation === "consumers") {
        return (await viewOf(tx, command, pool, row.slot)).consumers;
      }
      if (command.operation === "save") {
        await tx
          .update(claims)
          .set({ updatedAt: NOW })
          .where(eq(claims.id, row.id));
        await audit(tx, command, row, {
          kind: "saved",
          reason: "holder saved reconciliation evidence",
        });
        return null;
      }
      await report(tx, command, row);
      return null;
    })
    .catch(databaseFailure);
}

export { CoordinationError, executeCoordination };
