// What the orchestrator remembers between ticks,
// `runs/<slug>/orchestrator-memory.json`: the watchdog's restarts per issue
// and stage, each issue's streak of failed claims, and the issue holding the
// merge window. It is a cache: GitHub stays the source of truth, and losing
// the file loses only these counts and the window's holder. The installed
// version's `watchdog.json` is not read, so its counts never carry over.
// This module alone knows the file; a missing or malformed one reads as
// empty, and each save rewrites it atomically.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";

const MEMORY_FILE = "orchestrator-memory.json";
const JSON_INDENT = 2;
// An issue's streak of jobs whose claim failed with one error
// (claim-failures.ts): the error, how many in a row, and the startedAt of the
// last job counted.
const CLAIM_FAILURE = z.object({
  error: z.string(),
  count: z.number(),
  job: z.string(),
});
const MEMORY = z.object({
  // Restarts so far, by `<issue> <stage>` (watchdog.ts).
  resumes: z.record(z.string(), z.number()).catch({}),
  // The streaks of failed claims, by issue number.
  claimFailures: z.record(z.string(), CLAIM_FAILURE).catch({}),
  // The issue holding the merge window (schedule.ts), or null.
  mergeWindow: z.number().int().positive().nullable().catch(null),
});

type OrchestratorMemory = z.infer<typeof MEMORY>;
type ClaimFailure = z.infer<typeof CLAIM_FAILURE>;

const EMPTY: OrchestratorMemory = {
  resumes: {},
  claimFailures: {},
  mergeWindow: null,
};

function memoryFileOf(cfg: Config): string {
  return path.join(ROOT, "runs", cfg.slug, MEMORY_FILE);
}

function readMemory(cfg: Config): OrchestratorMemory {
  try {
    const text = fs.readFileSync(memoryFileOf(cfg), "utf8");
    const parsed = MEMORY.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A missing or unreadable file starts with nothing remembered.
  }
  return { ...EMPTY };
}

function saveMemory(cfg: Config, memory: OrchestratorMemory): void {
  const file = memoryFileOf(cfg);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(memory, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

export type { ClaimFailure, OrchestratorMemory };
export { readMemory, saveMemory };
