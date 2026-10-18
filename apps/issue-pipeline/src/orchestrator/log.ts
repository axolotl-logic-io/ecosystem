// The orchestrator's decision log, `runs/<slug>/orchestrator.log` (#234): one
// JSON line per scheduler decision, stop, close of a split parent or failed
// close, `{"at","issue","stage","action","reason"}`. A line that starts a
// job adds the job's `pid` and its id, `job`; a start that lifts a stopped
// issue logs a `lifted` line first, its reason the stop's code, and a start
// that sends the issue back to the author on new trusted input logs a
// `reauthor` line first, its reason the stage it resumes at after the author.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";

const LOG_FILE = "orchestrator.log";

interface LogEntry {
  at: string;
  issue: number;
  stage: string;
  action: string;
  reason: string;
  pid?: number;
  job?: string;
}

function logDecisions(cfg: Config, entries: readonly LogEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  const lines = entries.map(({ at, issue, stage, action, reason, pid, job }) =>
    JSON.stringify({ at, issue, stage, action, reason, pid, job }),
  );
  const file = path.join(ROOT, "runs", cfg.slug, LOG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

export type { LogEntry };
export { logDecisions };
