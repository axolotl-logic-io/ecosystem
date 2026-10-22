import { stat } from "node:fs/promises";
import { type BuddyRun, loadBuddyRuns } from "./buddy-runs.ts";
import type { Config } from "./config.ts";
import type { Remote } from "./github.ts";
import { readCap, safePath } from "./local-files.ts";
import { observeWebGate } from "./session-source.ts";
import { installedSchema, parse } from "./source-records.ts";
import { loadWorkflowRuns, type WorkflowRun } from "./workflow-source.ts";

interface Snapshot {
  workflowRuns: WorkflowRun[];
  buddyRuns: BuddyRun[];
  hold: boolean;
  installed: string;
  main: string;
  planMtime: string;
  pbWeb?: number[];
  pbWebBusy?: boolean;
  error?: string;
}
const empty: Snapshot = {
  workflowRuns: [],
  buddyRuns: [],
  hold: false,
  installed: "unknown",
  main: "unknown",
  planMtime: "missing",
};
async function snapshot(config: Config, remote: Remote): Promise<Snapshot> {
  const [workflowRuns, buddyRuns, installed, hold, planMtime] =
    await Promise.all([
      loadWorkflowRuns(config),
      loadBuddyRuns(config),
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
  const web = await observeWebGate(workflowRuns);
  const version = installedSchema.safeParse(parse(installed));
  let installedVersion = "unknown";
  if (version.success) {
    installedVersion =
      version.data.sha ?? version.data.commit ?? version.data.head ?? "unknown";
  }
  return {
    workflowRuns,
    buddyRuns,
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
