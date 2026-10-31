# Shared database

The workflow dashboard and Project Buddy use the shared `@ecosystem/db` PostgreSQL client and its monitoring tables. Task execution uses no database.

## Start the service

Docker Compose binds the pinned PostgreSQL 17 image to `127.0.0.1:55432` and stores data in a named volume. Do not expose that port publicly or share this volume with the disposable test service.

1. Copy `.env.example` to an untracked, owner-private `.env` at the repository root.
2. Replace the example password and matching URL password with the same private value.
3. Start the service:

   ```bash
   npm run db:up
   ```

4. Apply the committed migrations:

   ```bash
   (cd packages/db && node --env-file=../../.env ../../node_modules/drizzle-kit/bin.cjs migrate)
   ```

Run these commands at the ecosystem root under Node 24. Only one operator should run migrations at a time. Apps never create tables or migrate on connection.

`npm run db:down` stops the operational service without removing its volume. Do not use `docker compose down --volumes` as routine shutdown or recovery. PostgreSQL reads its initialization credentials only when it first creates the volume; changing `.env` alone does not rotate an existing database role's password.


## Monitoring schema

The [workflow dashboard](../../apps/workflow-dash/README.md) reads three monitoring tables. Its collector writes them from runtime records, session transcripts and GitHub issues.

| Table | Purpose |
| --- | --- |
| `monitor_entities` | The latest snapshot of each issue, action, session, buddy and health record. An older observation never overwrites a newer one. |
| `monitor_events` | Redacted transcript events with per-turn usage, context and compaction. `(source, position)` is unique, so a replay never duplicates an event. |
| `monitor_cursors` | Each transcript source's byte offset, advanced in the same transaction as its events. |

Monitoring tables describe work; they never grant ownership. Monitoring data has no automatic expiry. Keep monitoring data needed by other consumers; pipeline cleanup does not clear it.


## Test the database contract

The real database suites are opt-in and use disposable databases, never production data:

```sh
docker compose -f compose.test.yml up -d --wait
TEST_DATABASE_URL=postgresql://ecosystem_test:ecosystem_test@127.0.0.1:55433/ecosystem_test npm run test:database
```

This runs the shared package and dashboard database tests. Both default check gates only typecheck and lint the shared package. No app migrates automatically. Use the committed Drizzle migrations through `npm run db:migrate` when provisioning a database, with a private `DATABASE_URL` supplied by the operator. Preserve backups and coordinate migrations with all users of the database.
