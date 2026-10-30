import process from "node:process";
import { parseArgs } from "node:util";
import { checkLauncher, runLauncher } from "./task-app/launcher.ts";
import { openStop } from "./task-app/stop.ts";

const USAGE = "usage: buddy.mjs --config <buddy.json> [--check]";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function argsOf(argv: readonly string[]): { config: string; check: boolean } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      check: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.config === undefined) {
    throw new Error(USAGE);
  }
  return { config: values.config, check: values.check };
}

function check(config: string): void {
  process.stdout.write(`${JSON.stringify(checkLauncher(config))}\n`);
}

async function main(): Promise<0 | 1> {
  let args: { config: string; check: boolean };
  try {
    args = argsOf(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`buddy: ${messageOf(error)}\n`);
    return 1;
  }
  if (args.check) {
    try {
      check(args.config);
      return 0;
    } catch (error: unknown) {
      process.stderr.write(`buddy: ${messageOf(error)}\n`);
      return 1;
    }
  }
  const stop = openStop();
  try {
    const ended = await runLauncher(args.config, stop.buddy);
    process.stdout.write(`${JSON.stringify(ended)}\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`buddy: ${messageOf(error)}\n`);
    return 1;
  } finally {
    stop.close();
  }
}

process.exitCode = await main();
