import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { DatabaseConnection } from "@ecosystem/db";
import { configure } from "../config.ts";
import { parse } from "../source-records.ts";
import { collectMonitoring } from "./collector.ts";
import { monitoringConnection } from "./connection.ts";

const githubMilliseconds = 120_000;
const pollMilliseconds = 5000;
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    credentials: { type: "string" },
    once: { type: "boolean" },
  },
});
const configPath: string =
  values.config ?? join(dirname(import.meta.dirname), "workflow-dash.json");
const config = configure(parse(await readFile(configPath, "utf8")));
const connection: DatabaseConnection = await monitoringConnection(
  "writer",
  values.credentials,
);
let stopping = false;
let wake: (() => void) | undefined;
let githubAt = 0;
function stop(): void {
  stopping = true;
  wake?.();
}
function watch(): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    function schedule(): void {
      if (stopping) {
        resolve();
        return;
      }
      const timer = setTimeout((): void => {
        wake = undefined;
        cycle().then(schedule).catch(reject);
      }, pollMilliseconds);
      wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    }
    schedule();
  });
}
async function cycle(): Promise<void> {
  const github = Date.now() - githubAt >= githubMilliseconds;
  await collectMonitoring(connection.db, config, github);
  if (github) {
    githubAt = Date.now();
  }
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await cycle();
  if (values.once !== true) {
    await watch();
  }
} catch {
  process.stderr.write(
    "Monitoring collection failed; no coordination state was changed. Check database grants, migrations and source availability.\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await connection.close();
}
