import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { databaseUrl } from "./env.ts";

interface DatabaseConnection {
  db: NodePgDatabase;
  close: () => Promise<void>;
}

// Open on demand, not at import. Callers own and close the pool. Other apps
// can supply their own database role through the same DATABASE_URL boundary.
function openDatabase(url?: string): DatabaseConnection {
  const pool = new pg.Pool({
    connectionString: databaseUrl(url),
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    options:
      "-c statement_timeout=10000 -c lock_timeout=5000 -c application_name=ecosystem",
  });
  return {
    db: drizzle({ client: pool }),
    close: (): Promise<void> => pool.end(),
  };
}

type Database = DatabaseConnection["db"];

export type { Database, DatabaseConnection };
export { openDatabase };
