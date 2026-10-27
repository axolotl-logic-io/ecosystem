import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "../../src/client.ts";
import { openDatabase } from "../../src/client.ts";

const TEST_DATABASE = /^ecosystem_test(?:_[a-z0-9_]+)?$/u;
interface TestDatabase {
  db: Database;
  url: string;
  close: () => Promise<void>;
}

// Only a supplied local test server may create/drop this suite's fresh
// database. The configured database, operational database and other runs
// are never reset. The suite owns and closes its isolated database.
async function createTestDatabase(): Promise<TestDatabase> {
  const { TEST_DATABASE_URL: configured } = process.env;
  if (configured === undefined) {
    throw new Error(
      "TEST_DATABASE_URL is required; start the isolated test database first",
    );
  }
  const parsed = new URL(configured);
  if (
    !(
      ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
      TEST_DATABASE.test(parsed.pathname.slice(1))
    ) ||
    parsed.search !== ""
  ) {
    throw new Error(
      "test database must be a local ecosystem_test database without URL options",
    );
  }
  const admin = openDatabase(configured);
  const name = `ecosystem_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const create = sql.raw(`CREATE DATABASE "${name}"`);
  const drop = sql.raw(`DROP DATABASE "${name}"`);
  await admin.db.execute(create);
  parsed.pathname = `/${name}`;
  const connection = openDatabase(parsed.href);
  async function close(): Promise<void> {
    try {
      await connection.close();
      await admin.db.execute(drop);
    } finally {
      await admin.close();
    }
  }
  try {
    await migrate(connection.db, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });
    return {
      db: connection.db,
      url: parsed.href,
      close,
    };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

export type { TestDatabase };
export { createTestDatabase };
