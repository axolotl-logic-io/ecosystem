# Shared database package

`@ecosystem/db` owns ecosystem's native PostgreSQL client, Drizzle schema and
committed migrations. It is a workspace shared by apps, not an issue-pipeline
private database or a Project Buddy database.

```ts
import { openDatabase } from "@ecosystem/db/client";
import { claims } from "@ecosystem/db/tables";

const connection = openDatabase(); // validates private DATABASE_URL; connects lazily
try {
  const rows = await connection.db.select().from(claims);
  // Inspect typed rows; this read alone grants no operation authority.
} finally {
  await connection.close();
}
```

Apps own the connection lifecycle and use database roles with appropriate
grants. The historical coordination API remains in this shared package for compatibility; the issue pipeline no longer imports it. Monitoring uses independent tables and remains available to Project Buddy.

Run the fast static gate with `npm run check --workspace @ecosystem/db`.
For the separate real-database suite, start the disposable server and supply
`TEST_DATABASE_URL`; `@ecosystem/db/testing` exports the shared isolated
database fixture for workspace integration tests.

The [database reference](../../docs/reference/database.md) covers Docker setup,
configuration, schema constraints, generated and custom migrations, tests,
monitoring and isolated tests. No application migrates automatically.
