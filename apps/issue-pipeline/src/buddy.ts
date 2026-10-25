#!/usr/bin/env node
// The buddy runtime CLI, built as buddy.mjs: one activation of one buddy.
//
//   node buddy.mjs --config <buddy.json>
//   node buddy.mjs --config <buddy.json> --check
//
// It loads the trusted buddy file and every repository config in its scope
// (src/runtime/buddy-config.ts) and refuses, before any effect, a file that
// isn't trusted, an obsolete scheduler or assignment control, a role,
// responsibility, profile or account that doesn't agree, or a repository
// without its shared capacity. With --check it prints what it validated, one
// JSON object with each repository's authorization digest, and exits.
// Otherwise it runs every task loop it is responsible for, one action at a
// time, until SIGTERM or SIGINT stops it (src/runtime/activation.ts). The
// stop is cooperative: no new action, model session or op starts, live
// model sessions abort at their next safe point, and an op that writes,
// rebases or Lands runs to its end. A second signal only says so; SIGKILL
// remains the operator's explicit escalation. It then prints one JSON line,
// {buddyRun, kind, reason}, and exits 0 for a stop and 1 for a failure. Bad
// arguments or a refused configuration exit 1 with the reason on stderr.

import process from "node:process";
import { parseArgs } from "node:util";
import { activate } from "./runtime/activation.ts";
import { loadBuddy } from "./runtime/buddy-config.ts";
import { openStop } from "./runtime/stop.ts";

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
  const buddy = loadBuddy(config);
  const summary = {
    buddy: buddy.config.name,
    role: buddy.config.role,
    identity: buddy.config.identity.name,
    tasks: buddy.tasks,
    repositories: buddy.repositories.map((repository) => ({
      config: repository.file,
      repo: repository.cfg.repo,
      base: repository.cfg.baseBranch,
      modelSessions: repository.cfg.resources.modelSessions,
      authorization: repository.authorizationDigest,
    })),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
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
    const end = await activate(args.config, stop);
    process.stdout.write(
      `${JSON.stringify({ buddyRun: end.id, kind: end.kind, reason: end.reason })}\n`,
    );
    if (end.kind === "stopped") {
      return 0;
    }
    return 1;
  } catch (error: unknown) {
    process.stderr.write(`buddy: ${messageOf(error)}\n`);
    return 1;
  } finally {
    stop.close();
  }
}

process.exitCode = await main();
