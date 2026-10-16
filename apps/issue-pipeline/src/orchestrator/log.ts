// The orchestrator's decision log, `runs/<slug>/orchestrator.log` (#234): one
// JSON line per scheduler decision or watchdog action (#235),
// `{"at","issue","stage","action","reason"}`; and its escalations,
// `runs/<slug>/escalations.jsonl` (#235), one JSON line each,
// `{"at","issue","stage","reason","label"}`.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";
import type { Escalation } from "./escalate.ts";

const LOG_FILE = "orchestrator.log";
const ESCALATIONS_FILE = "escalations.jsonl";

interface LogEntry {
  at: string;
  issue: number;
  stage: string;
  action: string;
  reason: string;
}

function appendLines(
  cfg: Config,
  name: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) {
    return;
  }
  const file = path.join(ROOT, "runs", cfg.slug, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function logDecisions(cfg: Config, decisions: readonly LogEntry[]): void {
  const lines = decisions.map(({ at, issue, stage, action, reason }) =>
    JSON.stringify({ at, issue, stage, action, reason }),
  );
  appendLines(cfg, LOG_FILE, lines);
}

// Logs each escalation to orchestrator.log and to escalations.jsonl.
function logEscalations(cfg: Config, escalations: readonly Escalation[]): void {
  logDecisions(cfg, escalations);
  const lines = escalations.map(({ at, issue, stage, reason, label }) =>
    JSON.stringify({ at, issue, stage, reason, label }),
  );
  appendLines(cfg, ESCALATIONS_FILE, lines);
}

export { logDecisions, logEscalations };
