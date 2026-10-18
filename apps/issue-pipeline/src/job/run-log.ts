// The issue's local logs in its run folder, which outlive job.json, which
// the next job overwrites: one JSON line appended per entry. A write that
// fails is reported on stderr, which is the job's job.log, and the job goes
// on. The context log (context-log.ts) writes `context.jsonl`, the push
// server (commit-push.ts) `pushes.jsonl` and the usage effect
// (usage-append.ts) `jobs.jsonl`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type RunLog = "context.jsonl" | "pushes.jsonl" | "jobs.jsonl";

// Appends `entry` as one JSON line to log `name` in `runDir`.
function appendRunLine(runDir: string, name: RunLog, entry: unknown): void {
  const file = path.join(runDir, name);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (error: unknown) {
    process.stderr.write(`job: cannot append to ${file}: ${String(error)}\n`);
  }
}

export type { RunLog };
export { appendRunLine };
