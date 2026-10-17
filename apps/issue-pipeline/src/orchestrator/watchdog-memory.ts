// The watchdog's memory between ticks (#235), `runs/<slug>/watchdog.json`:
// the restarts per issue and stage, the steers sent to silent sessions and
// to failing ones, the jobs stopped for silence, the jobs stopped for their
// budget, what is escalated, and each issue's streak of failed claims. This module alone knows the file; a missing
// or malformed one reads as empty, and each save rewrites it atomically.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";

const MEMORY_FILE = "watchdog.json";
const JSON_INDENT = 2;
// A job the budget rule sent SIGTERM (watchdog-budget.ts): the launch past
// its budget, its context size and budget, and whether the issue is stopped.
const OVER_BUDGET = z.object({
  key: z.string(),
  contextTokens: z.number(),
  tokenBudget: z.number(),
  stopped: z.boolean(),
});
// An issue's streak of jobs whose claim failed with one error
// (claim-failures.ts): the error, how many in a row, and the startedAt of the
// last job counted.
const CLAIM_FAILURE = z.object({
  error: z.string(),
  count: z.number(),
  job: z.string(),
});
const MEMORY = z.object({
  // Restarts so far, by `<issue> <stage>`.
  resumes: z.record(z.string(), z.number()),
  // When each silent session was steered, by `<job startedAt> <launch key>`.
  steers: z.record(z.string(), z.string()),
  // The jobs it sent SIGTERM for silence, as `<issue> <job startedAt>`.
  killed: z.array(z.string()),
  // The failure count each streak was steered at, by `<job startedAt>
  // <launch key>`.
  failureSteers: z.record(z.string(), z.number()).default({}),
  // The jobs it sent SIGTERM for their budget, by `<issue> <job startedAt>`.
  overBudget: z.record(z.string(), OVER_BUDGET).default({}),
  // What is escalated (escalate.ts), as `<issue> <label>`.
  escalated: z.array(z.string()).default([]),
  // The streaks of failed claims, by issue number.
  claimFailures: z.record(z.string(), CLAIM_FAILURE).default({}),
});

// What the watchdog remembers between ticks.
type WatchMemory = z.infer<typeof MEMORY>;
type OverBudget = z.infer<typeof OVER_BUDGET>;
type ClaimFailure = z.infer<typeof CLAIM_FAILURE>;

function memoryFileOf(cfg: Config): string {
  return path.join(ROOT, "runs", cfg.slug, MEMORY_FILE);
}

function readWatchMemory(cfg: Config): WatchMemory {
  try {
    const text = fs.readFileSync(memoryFileOf(cfg), "utf8");
    const parsed = MEMORY.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A missing or unreadable file starts with nothing remembered.
  }
  return {
    resumes: {},
    steers: {},
    killed: [],
    failureSteers: {},
    overBudget: {},
    escalated: [],
    claimFailures: {},
  };
}

function saveWatchMemory(cfg: Config, memory: WatchMemory): void {
  const file = memoryFileOf(cfg);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(memory, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

export type { ClaimFailure, OverBudget, WatchMemory };
export { readWatchMemory, saveWatchMemory };
