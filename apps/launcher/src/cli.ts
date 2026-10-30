import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { checkLauncher, runLauncher } from "./launcher.ts";
import { openStop } from "./stop.ts";

const { ISSUE_PIPELINE_ROOT: installedRoot }: NodeJS.ProcessEnv = process.env;
const ROOT = path.resolve(
  installedRoot || path.join(os.homedir(), ".pi/agent/issue-pipeline"),
);
const USAGE = "usage: buddy.mjs --config <buddy.json> [--check]";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function argsOf(argv: readonly string[]): {
  config: string;
  check: boolean;
  manifest: string;
} {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      manifest: { type: "string", default: path.join(ROOT, "tasks.json") },
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
    manifest: values.manifest,
  };
}

function check(config: string, manifest: string): void {
  process.stdout.write(`${JSON.stringify(checkLauncher(config, manifest))}\n`);
}

async function main(): Promise<0 | 1> {
  let args: { config: string; check: boolean; manifest: string };
  try {
    args = argsOf(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(`buddy: ${messageOf(error)}\n`);
    return 1;
  }
  if (args.check) {
    try {
      check(args.config, args.manifest);
      return 0;
    } catch (error: unknown) {
      process.stderr.write(`buddy: ${messageOf(error)}\n`);
      return 1;
    }
  }
  const stop = openStop();
  try {
    const ended = await runLauncher(args.config, args.manifest, stop.buddy);
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
