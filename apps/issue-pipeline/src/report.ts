#!/usr/bin/env node
// The pipeline's reports.
//
//   node report.mjs usage --config <path> [--since <date>] [--role <role>]
//     [--issue <n>]
//
// `usage` lists the repo's issue comments, changed at or after --since when
// it is given, in one paged listing, and prints the usage report on the
// config account's usage records (src/report/usage.ts): sessions grouped by
// role, state and model, the flagged sessions with their reasons, and each
// role's tools with the most output. An unknown subcommand or flag, a bad
// date, role or issue, or a missing --config exits 1 with the reason on
// stderr.

import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { listRepoComments } from "./comments.ts";
import { loadConfig } from "./config.ts";
import { USAGE_ROLES } from "./job/usage-log.ts";
import { formatReport, usageReport } from "./report/usage.ts";

const NO_CONFIG = "--config must name a repo config file";
const USAGE_ARGS = z.object({
  command: z.literal("usage", { error: "the report must be `usage`" }),
  config: z.string({ error: NO_CONFIG }).min(1, NO_CONFIG),
  since: z
    .union([z.iso.datetime({ offset: true }), z.iso.date()], {
      error: "--since must be an ISO date or time",
    })
    .transform((since) => new Date(since).toISOString())
    .nullable(),
  role: z.enum(USAGE_ROLES).nullable(),
  issue: z.coerce.number().int().positive().nullable(),
});

type UsageArgs = z.infer<typeof USAGE_ARGS>;

function usageArgsOf(argv: readonly string[]): UsageArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      since: { type: "string" },
      role: { type: "string" },
      issue: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) {
    throw new Error("give one report: usage");
  }
  const { since = null, role = null, issue = null } = values;
  const [command] = positionals;
  const parsed = USAGE_ARGS.safeParse({
    ...values,
    command,
    since,
    role,
    issue,
  });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function main(argv: readonly string[]): 0 | 1 {
  try {
    const { config, since, role, issue } = usageArgsOf(argv);
    const cfg = loadConfig(config);
    const comments = listRepoComments(cfg, since);
    const options = { account: cfg.landingAccount, role, issue, since };
    const report = usageReport(comments, options, cfg.usageFlags);
    process.stdout.write(formatReport(report));
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`report: ${messageOf(error)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
