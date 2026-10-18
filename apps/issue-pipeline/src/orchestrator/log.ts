// The orchestrator's decision log, `runs/<slug>/orchestrator.log` (#234): one
// JSON line per scheduler decision, watchdog action (#235) or closed split
// parent (#378), `{"at","issue","stage","action","reason"}`; and its
// escalations, `runs/<slug>/escalations.jsonl` (#235), one JSON line each,
// `{"at","issue","stage","reason","label"}`, from the watchdog's rules or a
// split parent's close that failed (#378). A line that starts a job adds the
// job's `pid` and its id, `job`; an issue whose stop label was removed while
// its state is still saved at `stopped` logs a `lifted` line, its reason the
// label, before its start; and an escalation from the watchdog's rules adds
// the `attempt` its stage is at and the issue's reportedTokens so far,
// `issueTokens`. A run logs the roles it chose once, at its start (#417), as
// `{"at","action":"roles","roles"}`.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";

const LOG_FILE = "orchestrator.log";
const ESCALATIONS_FILE = "escalations.jsonl";

interface LogEntry {
  at: string;
  issue: number;
  stage: string;
  action: string;
  reason: string;
  pid?: number;
  job?: string;
  attempt?: number;
  issueTokens?: number;
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
  const lines = decisions.map((entry) => {
    const { at, issue, stage, action, reason } = entry;
    const { pid, job, attempt, issueTokens } = entry;
    const line = { at, issue, stage, action, reason };
    return JSON.stringify({ ...line, pid, job, attempt, issueTokens });
  });
  appendLines(cfg, LOG_FILE, lines);
}

// Logs the roles a run chose to orchestrator.log.
function logRoles(cfg: Config, at: string, roles: readonly string[]): void {
  appendLines(cfg, LOG_FILE, [JSON.stringify({ at, action: "roles", roles })]);
}

// Logs each escalation to orchestrator.log and to escalations.jsonl.
function logEscalations(
  cfg: Config,
  escalations: readonly (LogEntry & { label: string })[],
): void {
  logDecisions(cfg, escalations);
  const lines = escalations.map(({ at, issue, stage, reason, label }) =>
    JSON.stringify({ at, issue, stage, reason, label }),
  );
  appendLines(cfg, ESCALATIONS_FILE, lines);
}

export type { LogEntry };
export { logDecisions, logEscalations, logRoles };
