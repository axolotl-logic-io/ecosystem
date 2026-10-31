import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { type DatabaseConnection, openDatabase } from "@ecosystem/db";

const credentialReadBytes = 16_384;
const nonOwnerPermissionRange = 0o100;

// The reader and collector are provisioned separately; neither falls back to
// other credentials or an inherited DATABASE_URL.
async function monitoringConnection(
  role: "reader" | "writer",
  credentialFile?: string,
): Promise<DatabaseConnection> {
  const path =
    credentialFile ??
    join(homedir(), `.config/issue-pipeline/monitoring-${role}.env`);
  let connection: DatabaseConnection | null = null;
  try {
    const file = await open(path, constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.mode % nonOwnerPermissionRange !== 0 ||
        info.size > credentialReadBytes
      ) {
        throw new Error("Private credential file required");
      }
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const { DATABASE_URL: url } = parseEnv(text);
    if (url === undefined) {
      throw new Error("Database URL missing");
    }
    connection = openDatabase(url);
  } catch {
    connection = null;
  }
  if (connection === null) {
    throw new Error(
      `Monitoring ${role} connection unavailable; provision its private credential file`,
    );
  }
  return connection;
}

export { monitoringConnection };
