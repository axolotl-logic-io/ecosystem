// The watchdog's memory between ticks (#235), `runs/<slug>/watchdog.json`:
// the restarts per issue and stage, the steers sent to silent sessions and
// to failing ones, the jobs stopped for silence, and what is escalated. This module alone knows the file; a missing
// or malformed one reads as empty, and each save rewrites it atomically.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";
import type { WatchMemory } from "./watchdog.ts";

const MEMORY_FILE = "watchdog.json";
const JSON_INDENT = 2;
const MEMORY = z.object({
  resumes: z.record(z.string(), z.number()),
  steers: z.record(z.string(), z.string()),
  killed: z.array(z.string()),
  failureSteers: z.record(z.string(), z.number()).default({}),
  escalated: z.array(z.string()).default([]),
});

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
    escalated: [],
  };
}

function saveWatchMemory(cfg: Config, memory: WatchMemory): void {
  const file = memoryFileOf(cfg);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(memory, null, JSON_INDENT)}\n`);
  fs.renameSync(temp, file);
}

export { readWatchMemory, saveWatchMemory };
