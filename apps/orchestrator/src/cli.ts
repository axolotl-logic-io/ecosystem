import process from "node:process";
import { parseArgs } from "node:util";
import { installRootOf } from "@ecosystem/launcher/install-root";
import { openStop } from "@ecosystem/launcher/stop";
import { checkOrchestrator } from "./config.ts";
import { runOrchestrator } from "./supervisor.ts";

async function main(): Promise<0 | 1> {
  const stop = openStop();
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        check: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.config === undefined) {
      throw new Error(
        "usage: orchestrator.mjs --config <fleet.json> [--check]",
      );
    }
    const root = installRootOf(process.env);
    if (values.check) {
      process.stdout.write(
        `${JSON.stringify(checkOrchestrator(values.config, root))}\n`,
      );
      return 0;
    }
    const ended = await runOrchestrator(values.config, root, stop.buddy);
    process.stdout.write(`${JSON.stringify(ended)}\n`);
    if (ended.failed.length > 0) {
      return 1;
    }
    return 0;
  } catch (error: unknown) {
    let message = String(error);
    if (error instanceof Error) {
      ({ message } = error);
    }
    process.stderr.write(`orchestrator: ${message}\n`);
    return 1;
  } finally {
    stop.close();
  }
}

process.exitCode = await main();
