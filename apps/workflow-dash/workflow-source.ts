import { join } from "node:path";
import { collect } from "./collection.ts";
import type { Config } from "./config.ts";
import { dirs, readCap, sourceReadBytes } from "./local-files.ts";
import {
  live,
  type ProcessCheck,
  pidWorkflowRun,
} from "./process-observations.ts";
import {
  type JournalRecord,
  journalSchema,
  jsonl,
  parse,
  type WorkflowData,
  workflowSchema,
} from "./source-records.ts";
import { ms, type TimedLaunch, timeline, today } from "./time.ts";

const issueDirectory = /^issue-(?<issue>\d+)$/u;
const verifySummary = /ℹ.*(?:tests|pass|fail|cancelled)/u;
const summaryReadBytes = 32_768;
const summaryLineCount = 8;
const retainedVerifyLogs = 3;
interface WorkflowRun {
  repo: string;
  issue: number;
  dir: string;
  data: WorkflowData;
  live: boolean | null;
  records: JournalRecord[];
  pbWebObserved?: boolean;
}
interface RunDetails {
  timeline: TimedLaunch[];
  verify: string[];
  stopReason: unknown;
}

function historicalRuns(current: WorkflowRun): WorkflowRun[] {
  return current.records.flatMap((record) => {
    if (
      record.kind !== "job" ||
      typeof record.job !== "string" ||
      record.job === current.data.id ||
      !today(record.at)
    ) {
      return [];
    }
    let stage = record.role;
    if (Array.isArray(record.stages)) {
      stage = record.stages.at(-1);
    }
    return [
      {
        ...current,
        live: false,
        records: [],
        data: {
          id: record.job,
          history: true,
          stage,
          startedAt: record.jobStartedAt,
          endedAt: record.at,
          outcome: record.outcome,
          reason: record.reason ?? record.stopReason,
          launches: [],
        },
      },
    ];
  });
}
async function readWorkflow(
  repo: string,
  directory: string,
  check: ProcessCheck,
): Promise<WorkflowRun[]> {
  const name = directory.split("/").at(-1) ?? "";
  const match = issueDirectory.exec(name);
  if (match === null) {
    return [];
  }
  const parsed = workflowSchema.safeParse(
    parse(await readCap(join(directory, "job.json"), sourceReadBytes)),
  );
  if (!parsed.success) {
    return [];
  }
  const records = jsonl(
    await readCap(join(directory, "jobs.jsonl"), sourceReadBytes, true),
  ).flatMap((record) => {
    const result = journalSchema.safeParse(record);
    if (result.success) {
      return [result.data];
    }
    return [];
  });
  const { issue } = match.groups ?? {};
  const current: WorkflowRun = {
    repo,
    issue: Number(issue),
    dir: directory,
    data: parsed.data,
    live: await live(parsed.data, check),
    records,
  };
  return [current, ...historicalRuns(current)];
}
async function loadWorkflowRuns(
  config: Config,
  check: ProcessCheck = pidWorkflowRun,
): Promise<WorkflowRun[]> {
  const locations = await collect(config.repos, async (repo) => {
    const root = join(config.runs, repo.replace("/", "__"));
    return (await dirs(root))
      .filter((name) => issueDirectory.test(name))
      .map((name) => ({ repo, directory: join(root, name) }));
  });
  const runs = await collect(locations.flat(), ({ repo, directory }) =>
    readWorkflow(repo, directory, check),
  );
  return runs
    .flat()
    .sort((a, b) => ms(b.data.startedAt) - ms(a.data.startedAt));
}
async function verificationLog(
  directory: string,
  name: string,
): Promise<string[]> {
  const text = await readCap(
    join(directory, name, "test.log"),
    summaryReadBytes,
    true,
  );
  const summary = text
    .split("\n")
    .filter((line) => verifySummary.test(line))
    .slice(-summaryLineCount);
  if (summary.length === 0) {
    return [];
  }
  return [`${name}\n${summary.join("\n")}`];
}
function stopReason(run: WorkflowRun): unknown {
  const relevant = run.records.filter(
    (record) =>
      record.reason !== undefined ||
      record.stopReason !== undefined ||
      record.outcome !== undefined,
  );
  const last =
    relevant
      .filter(
        (record) =>
          record.reason !== undefined || record.stopReason !== undefined,
      )
      .at(-1) ?? relevant.at(-1);
  return (
    run.data.stopReason ??
    run.data.reason ??
    last?.stopReason ??
    last?.reason ??
    run.data.outcome ??
    last?.outcome ??
    "not recorded"
  );
}
async function workflowRunDetails(run: WorkflowRun): Promise<RunDetails> {
  if (run.data.history === true) {
    return {
      timeline: [],
      verify: [
        "Historical workflow run: launches and verify logs cannot be correlated after job.json is replaced.",
      ],
      stopReason: run.data.reason ?? run.data.outcome ?? "not recorded",
    };
  }
  const names = (await dirs(run.dir))
    .filter((name) => name.startsWith("verify-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const logs = await collect(names, (name) => verificationLog(run.dir, name));
  return {
    timeline: timeline(run),
    verify: logs.flat().slice(-retainedVerifyLogs),
    stopReason: stopReason(run),
  };
}

export type { RunDetails, WorkflowRun };
export { loadWorkflowRuns, workflowRunDetails };
