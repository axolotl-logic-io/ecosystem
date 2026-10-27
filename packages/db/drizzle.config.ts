import { defineConfig } from "drizzle-kit";
import { toolingDatabaseUrl } from "./src/env.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/tables",
  out: "./drizzle",
  dbCredentials: { url: toolingDatabaseUrl() },
});
