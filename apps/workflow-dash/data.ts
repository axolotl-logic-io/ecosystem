import { stat } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { Remote } from "./github.ts";
import { type HistoricalJob, loadJobHistory } from "./job-history.ts";
import { readCap, safePath } from "./local-files.ts";
import {
  emptyRuntimeRuns,
  loadRuntimeRuns,
  type RuntimeRuns,
} from "./runtime-runs.ts";
import { observeWebGate } from "./session-source.ts";
import { installedSchema, parse } from "./source-records.ts";
import { loadSubagentRuns, type SubagentRun } from "./subagent-runs.ts";

interface Snapshot {
  /** Buddy-run and action-run observations from the buddy runtime. */
  runtime: RuntimeRuns;
  /** Generic pi-subagents harness records; not domain buddy runs. */
  subagentRuns: SubagentRun[];
  /** Retired job runtime records, kept as historical evidence only. */
  jobHistory: HistoricalJob[];
  configWarnings: string[];
  hold: boolean;
  installed: string;
  main: string;
  planMtime: string;
  pbWeb?: number[];
  pbWebBusy?: boolean;
  error?: string;
}
const empty: Snapshot = {
  runtime: emptyRuntimeRuns,
  subagentRuns: [],
  jobHistory: [],
  configWarnings: [],
  hold: false,
  installed: "unknown",
  main: "unknown",
  planMtime: "missing",
};
async function snapshot(config: Config, remote: Remote): Promise<Snapshot> {
  const [runtime, jobHistory, subagentRuns, installed, hold, planMtime] =
    await Promise.all([
      loadRuntimeRuns(config),
      loadJobHistory(config),
      loadSubagentRuns(config),
      readCap(config.installed),
      stat(await safePath(config.hold)).then(
        () => true,
        () => false,
      ),
      stat(await safePath(config.plan)).then(
        (info) => info.mtime.toISOString(),
        () => "missing",
      ),
    ]);
  const web = await observeWebGate(jobHistory);
  const version = installedSchema.safeParse(parse(installed));
  let installedVersion = "unknown";
  if (version.success) {
    installedVersion =
      version.data.sha ?? version.data.commit ?? version.data.head ?? "unknown";
  }
  return {
    runtime,
    subagentRuns,
    jobHistory,
    configWarnings: config.warnings,
    hold,
    installed: installedVersion,
    main: remote.main,
    planMtime,
    pbWeb: web.issues,
    pbWebBusy: web.busy,
  };
}

export type { Snapshot };
export { empty, snapshot };
