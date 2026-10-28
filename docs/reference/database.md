# Shared database

Ecosystem owns one PostgreSQL service and the `@ecosystem/db` workspace in `packages/db/`. Apps share its connection, Drizzle schema and migrations. This database is independent of Project Buddy's databases. It uses native PostgreSQL connections through `pg`, not Project Buddy's Neon HTTP proxy.

The issue pipeline can explicitly select PostgreSQL for issue execution, model-session reservations, consumer completion and Land integration turns. GitHub remains the default backend. Requirements, accepted human signals, attempts and results, questions, checkpoints and reviews still use GitHub. The workflow dashboard continues to read run observations; this change does not give it database credentials or add a database view.

The database is short-term operational storage. It keeps buddies from starting the same work twice, and it records who held what and when. It is not the only record of the work, and two instances of it may disagree. A reset or a second database can let two buddies work on the same issue. That costs duplicate effort but never loses or overwrites work; see [disagreement and reset](#disagreement-and-reset).

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

Run these commands at the ecosystem root under Node 24. Only one operator should run migrations at a time. Apps never create tables or migrate on connection. A pipeline command against a database with no tables fails with a message that asks for `npm run db:migrate`, and it works once the migrations are applied, with no configuration change.

`npm run db:down` stops the operational service without removing its volume. Do not use `docker compose down --volumes` as routine shutdown or recovery. PostgreSQL reads its initialization credentials only when it first creates the volume; changing `.env` alone does not rotate an existing database role's password.

## Shared client

`@ecosystem/db/client` exports `openDatabase()`. It creates a lazy, bounded `pg` pool, a typed Drizzle client and an asynchronous `close()` function. `@ecosystem/db/tables` exports the shared schema. `DATABASE_URL` must contain an explicit PostgreSQL host, database, username and password. Applications own connection shutdown; they must not create a pool for each query.

The pipeline's synchronous guarded operations use the bundled `database.mjs` subprocess. It reads the selected private credential file, performs one bounded transaction and closes the connection. Ordinary model, shell and Git children do not inherit database URLs, password variables or service/password-file references. This is credential separation, not a same-user filesystem sandbox.

For another app, provision its own database role with only the grants it needs. A read-only observer does not need coordination writes or migration privileges. Keep all connection strings out of tracked configuration and logs.

## Coordination schema

| Table | Purpose and tracking |
| --- | --- |
| `coordination_repositories` | Unique repository/base scope and creation timestamp |
| `coordination_pools` | Scope kind, issue or shared resource, capacity, creation and update timestamps |
| `coordination_claims` | Invocation/action UUID, lane, issue, branch, optional buddy-run UUID/task, source issue-claim foreign key, slot/capacity, creation/update/verification/release timestamps |
| `coordination_consumers` | Claim foreign key, typed external consumer identity, creation/update/completion timestamps |
| `coordination_events` | Append-only acquisition, release, saved-evidence, registration and completion history; claim/consumer links, actor UUID, buddy/task, reason, evidence and creation timestamp |

PostgreSQL generates timestamps with time zones. Immutable rows need a creation timestamp, not a redundant update timestamp. Released claims and finished consumers remain available for diagnosis. `last_verified_at` records an ownership check; it is not a heartbeat, deadline or permission to take over.

A committed claim is ownership. There is no pending-request queue, confirmation phase, cancellation row or lease status. A unique partial index admits one live owner per pool slot. Another unique index prevents an invocation from acquiring a second slot in the same pool. Contenders receive a known loss only after the transaction confirms it; first committed acquisition wins, without a fairness guarantee.

Foreign keys, check constraints and integrity triggers protect scope relationships and lifecycle transitions within one database. Resource claims require the matching live issue claim. An issue cannot release while its resource claims remain live. A reservation cannot release while a registered consumer remains unfinished. Capacity cannot change until the pool drains. Claim identity and history are immutable; release and completion cannot be reversed. These rules apply to direct SQL writes as well as the shared client. Database administrators remain trusted and must not disable these protections to resume work.

The transaction stores the claim and its audit event together. Typed relational rows grant ownership; audit JSON never grants it. Per-repository/base row locks serialize coordination changes. Lost responses, process exit, elapsed time and closed issues release nothing. Reconcile the original invocation after an unknown outcome; do not substitute a new action UUID or retry a GitHub effect.

## Disagreement and reset

A claim is this database's answer to "who is working on this now". Another database, or this one after a reset, may answer differently, and the pipeline treats that as normal. A reset or empty database accepts the same configuration and commands; no identity check or manual hold stops it.

Durable work lives on GitHub, not in the database. When two buddies end up on the same issue, these GitHub-side protections keep the collision harmless:

| Effect | What protects it without the database |
| --- | --- |
| Branch pushes | Every push only fast-forwards. A push that would replace another worker's commits goes to a recovery branch instead, and the run fails without opening a PR. |
| Task attempts and results | The landing account's records on the issue. A second attempt of a run, or a conflicting verdict, holds the item for a person. |
| Land merges | Land rechecks its evidence just before it merges, and it merges only the exact head it checked (`--match-head-commit`). A second Land attempt of the same binding is refused before it is recorded, or holds the item if both are recorded at once. |
| Verify reviews | Each review names the exact head commit it judged. |
| Issue closing | Land closes an issue only after GitHub reads its PR merged at the checked head. |

The integration turn still matters for Land on one target. Land rechecks the base just before it merges, but two Lands that disagree about the turn could each pass that check moments apart. The second merge would then combine two PRs that were never checked together. To close that window on GitHub too, turn on branch protection's requirement that a PR's branch is up to date before it merges.

The model-session cap is a hard limit, and it holds only within one database. Two databases, or a reset while sessions run, can each grant the full cap. Point every buddy that shares a pool at the same database, and reset or replace the database only while those buddies are stopped.

After a reset, buddies continue from GitHub. A run that was lost before it recorded a result is settled by reading GitHub, and an interrupted Implement run continues from its pushed branch; see [interrupted Implement runs](task-results.md#interrupted-implement-runs).

## Select PostgreSQL coordination

The repository's private operator config accepts:

```json
{
  "coordination": {
    "backend": "postgres",
    "credentialsEnvFile": "/absolute/private/path/database.env"
  }
}
```

The absolute credential path must name an operator-owned regular file with no group or other permissions. Its contents are:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:55432/ecosystem
```

Replace `USER` and `PASSWORD` with the provisioned database role and URL-encoded password. Do not print or export this connection string to model children. Keep this file separate from GitHub and model credentials.

Omitting `coordination` selects `{ "backend": "github" }`. PostgreSQL selection binds the buddy authorization digest. Missing credentials, unreadable responses and database failures hold work; none falls back to GitHub or writes to both stores.

## Cut over a repository

The backend is shared authority for every buddy and standalone operator working on the same repository/base, not an individual buddy preference.

1. Stop new admissions on every participant using the old backend.
2. Let in-flight actions, external effects and registered consumers settle cooperatively.
3. Confirm that issue ownership, model-session reservations and integration turns have drained in GitHub, including retained work and uncertain-write journals.
4. Preserve the old authority records, operator configs, run observations and recovery evidence.
5. Apply the database migrations.
6. Install the distribution, including `database.mjs`.
7. Point every participant for that repository/base at the same database and credential scope.
8. Validate the private buddy configurations without activation.
9. Authorize activation separately.

A retained legacy claim blocks cutover. The GitHub backend's claims are its only record of ownership, so drain them; don't expire or erase them. There is no automatic import, takeover, deletion, dual-write interval or fallback. Do not delete GitHub comments or refs to make the source appear drained. A mixed-backend rollout admits two owners and splits the model-session cap, so do not switch one buddy while another still uses GitHub. Accepted signals and attempts retain their existing identities; changing the coordination backend does not renew spent causes.

Before rolling back, stop admissions and drain the PostgreSQL claims and consumers first. An older binary cannot see live database ownership. Binary rollback alone is not an authority rollback.

## Preserve and restore data

Back up the whole database, including the Drizzle migration journal, released claims and audit history. A backup keeps the tracking history; the work itself is on GitHub. Keep backups outside the checkout with owner-only permissions. For a consistent backup, `pg_dump` can read a running database; preserve its relationship to the operator configuration and external-effect receipts.

```bash
umask 077
docker compose exec -T database sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > BACKUP_FILE
```

`BACKUP_FILE` is the private backup path. Test restoration into a separate empty database, never over the live database. A restored database holds the claims of the moment of the backup, which may be stale. As with a reset, stop the buddies that share a pool before you switch them to a restored or new database, so the model-session cap holds.

## Change the schema

Edit `packages/db/src/tables/` and run `npm run db:generate`. Commit the generated SQL and metadata. Use `npm run db:generate --workspace @ecosystem/db -- --custom --name=NAME` for custom SQL; replace `NAME` with a descriptive migration name. Integrity triggers live in a custom migration, not the generated TypeScript snapshot. Change those protections with the schema and add database tests for the invariant.

Do not regenerate an applied migration, run schema push against operational data or add automatic migration to a buddy. Plan compatibility and a drained deployment when an application change needs it.

## Test the database contract

The default fast and full gates do not connect to PostgreSQL. The separate database suite requires Docker or an explicitly supplied local test PostgreSQL server:

```bash
npm run db:test:up
TEST_DATABASE_URL=postgresql://ecosystem_test:ecosystem_test@127.0.0.1:55433/ecosystem_test npm run test:database
npm run db:test:down
```

The disposable service uses a separate Compose project, port and tmpfs storage. Each suite validates that its supplied URL names a local `ecosystem_test` database, creates a fresh UUID-named database, applies the committed migrations and drops only its own database afterward. The configured database is never reset. Test credentials grant database creation only in this isolated service; never supply an operational URL.

The tests cover concurrent issue and resource claims, scope isolation, capacity changes, consumer retention, immutable history, restarts, an unmigrated database, two databases that disagree, a reset database with unchanged configuration, relocated bundles and the pipeline reservation adapter with GitHub prohibited. The GitHub `database` job provisions PostgreSQL and runs this suite. Fake-GitHub runtime tests remain in `npm run check:full`; neither suite alone is coverage of every task against a live database and live GitHub.
