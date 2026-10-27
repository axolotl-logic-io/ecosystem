// Privileged, one-request database entrypoint. The model never receives its
// connection string. Typed package transactions remain directly available to
// asynchronous ecosystem apps; this entrypoint preserves the ops contract.

import fs from "node:fs";
import process from "node:process";
import { parseEnv } from "node:util";
import { openDatabase } from "@ecosystem/db";
import {
  CoordinationError,
  executeCoordination,
} from "@ecosystem/db/coordination";
import { COMMAND } from "@ecosystem/db/protocol";
import { z } from "zod";

const REQUEST = z.strictObject({
  credentialsEnvFile: z.string().min(1),
  command: COMMAND,
});
const PRIVATE_MODE = 0o100;

function databaseCredential(file: string): string {
  const info = fs.statSync(file);
  if (
    !info.isFile() ||
    info.mode % PRIVATE_MODE !== 0 ||
    info.uid !== process.getuid?.()
  ) {
    throw new CoordinationError(
      "database credential file must be private to its current owner",
    );
  }
  const { DATABASE_URL: selected } = parseEnv(fs.readFileSync(file, "utf8"));
  if (selected === undefined || selected.trim() === "") {
    throw new CoordinationError(
      "database credential file must set DATABASE_URL",
    );
  }
  return selected;
}

async function main(): Promise<void> {
  try {
    const request = REQUEST.parse(JSON.parse(fs.readFileSync(0, "utf8")));
    const connection = openDatabase(
      databaseCredential(request.credentialsEnvFile),
    );
    let result: Awaited<ReturnType<typeof executeCoordination>>;
    try {
      result = await executeCoordination(connection.db, request.command);
    } finally {
      await connection.close();
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error: unknown) {
    let reason =
      "database operation unreadable or unconfirmed; reconcile the same invocation before retrying";
    if (error instanceof CoordinationError) {
      reason = error.message;
    }
    // Driver diagnostics can contain credentials, SQL parameters or paths.
    // Do not forward them through the public ops/observation boundary.
    process.stdout.write(JSON.stringify({ ok: false, reason }));
  }
}

await main();
