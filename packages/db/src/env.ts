import process from "node:process";
import { z } from "zod";

const POSTGRES_URL = z.url().refine((value: string): boolean => {
  const parsed = new URL(value);
  return (
    (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
    parsed.hostname !== "" &&
    parsed.pathname.length > 1 &&
    parsed.username !== "" &&
    parsed.password !== ""
  );
});

// Errors never include a connection string, which contains credentials.
function databaseUrl(value?: string): string {
  const { DATABASE_URL: configured } = process.env;
  const parsed = POSTGRES_URL.safeParse(value ?? configured);
  if (!parsed.success) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  return parsed.data;
}

function toolingDatabaseUrl(): string {
  const { DATABASE_URL: configured } = process.env;
  return configured?.trim() ?? "";
}

export { databaseUrl, toolingDatabaseUrl };
