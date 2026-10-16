// The orchestrator's decision log, `runs/<slug>/orchestrator.log` (#234): one
// JSON line per decision, `{"at","issue","stage","action","reason"}`.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { ROOT } from "../pipeline-root.ts";
import type { Decision } from "./schedule.ts";

const LOG_FILE = "orchestrator.log";

function logDecisions(cfg: Config, decisions: readonly Decision[]): void {
  if (decisions.length === 0) {
    return;
  }
  const file = path.join(ROOT, "runs", cfg.slug, LOG_FILE);
  const lines = decisions.map(({ at, issue, stage, action, reason }) =>
    JSON.stringify({ at, issue, stage, action, reason }),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

export { logDecisions };
