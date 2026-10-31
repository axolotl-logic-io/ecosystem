import process from "node:process";
import { parseArgs } from "node:util";
import { installRootOf } from "./install-root.ts";
import { checkLauncher, runLauncher } from "./launcher.ts";
import { openStop } from "./stop.ts";

const USAGE = "usage: launcher.mjs --config <buddy.json> [--check]";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface Args {
  config: string;
  check: boolean;
  root: string;
}

function argsOf(argv: readonly string[]): Args {
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
  return {
    config: values.config,
    check: values.check,
    root: installRootOf(process.env),
  };
}

function check(config: string, root: string): void {
  process.stdout.write(`${JSON.stringify(checkLauncher(config, root))}\n`);
}

async function main(): Promise<0 | 1> {
  let args: Args;
  try {
    args = argsOf(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`buddy: ${messageOf(error)}\n`);
    return 1;
  }
  if (args.check) {
    try {
      check(args.config, args.root);
      return 0;
    } catch (error: unknown) {
      process.stderr.write(`buddy: ${messageOf(error)}\n`);
      return 1;
    }
  }
  const stop = openStop();
  try {
    const ended = await runLauncher(args.config, args.root, stop.buddy);
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
