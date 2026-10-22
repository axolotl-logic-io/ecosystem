import { homedir } from "node:os";
import { basename, join } from "node:path";
import { collect } from "./collection.ts";
import { capacity } from "./legacy-capacity.ts";
import { files, readCap, sourceReadBytes } from "./local-files.ts";
import { processList } from "./process-observations.ts";
import { jsonl, type SessionRecord, sessionSchema } from "./source-records.ts";
import { type SessionTime, sessionTime, today } from "./time.ts";
import type { WorkflowRun } from "./workflow-source.ts";

const gateCommand =
  /(?:playwright|vitest|(?:npm|pnpm|yarn).*\b(?:test|gate|verify)\b|next\s+(?:dev|build|start))/u;
const webRunner = /\b(?:playwright|vitest|next(?:-server)?)\b/u;
const excludedProcess = /\b(?:grep|capture-pane)\b/u;
const issuePath = /(?:issue-|issue\/)(?<issue>\d+)\b/gu;
const reviewerLaunch = /^reviewer-[\w-]+$/u;
const sessionFilename = /^[\w-]+\.jsonl$/u;

function sessionRecords(text: string): SessionRecord[] {
  return jsonl(text).flatMap((record) => {
    const result = sessionSchema.safeParse(record);
    if (result.success) {
      return [result.data];
    }
    return [];
  });
}
function gateCallIds(message: SessionRecord["message"]): string[] {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content.flatMap((content) => {
      if (
        content.type === "toolCall" &&
        content.name === "bash" &&
        typeof content.id === "string" &&
        gateCommand.test(content.arguments?.command ?? "")
      ) {
        return [content.id];
      }
      return [];
    });
  }
  return [];
}
function runningGate(records: SessionRecord[]): boolean {
  const open = new Set<string>();
  for (const { message } of records) {
    for (const id of gateCallIds(message)) {
      open.add(id);
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string"
    ) {
      open.delete(message.toolCallId);
    }
  }
  return open.size > 0;
}
/** Positive activity only: absence does not establish an available scope lock. */
function webProcesses(
  text: string,
  root = join(
    homedir(),
    ".pi/agent/issue-pipeline/work/axolotl-logic-io__project-buddy",
  ),
): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        webRunner.test(line) &&
        (line.includes(`${root}/`) || line.endsWith(root)) &&
        !excludedProcess.test(line),
    );
}
async function reviewerGate(run: WorkflowRun): Promise<void> {
  const launch = run.data.launches.at(-1);
  if (
    run.live === true &&
    run.repo.endsWith("/project-buddy") &&
    launch !== undefined &&
    reviewerLaunch.test(launch.key)
  ) {
    const text = await readCap(
      join(run.dir, "sessions", `${launch.key}.jsonl`),
      sourceReadBytes,
      true,
    );
    run.pbWebObserved = runningGate(sessionRecords(text));
  }
}
async function observeWebGate(
  runs: WorkflowRun[],
  processRead: () => Promise<string> = processList,
): Promise<{ issues: number[]; busy: boolean }> {
  await collect(runs, reviewerGate);
  const processes = webProcesses(await processRead());
  const issues = new Set(capacity(runs).pbWeb);
  for (const line of processes) {
    for (const match of line.matchAll(issuePath)) {
      const { issue } = match.groups ?? {};
      issues.add(Number(issue));
    }
  }
  return { issues: [...issues], busy: issues.size > 0 || processes.length > 0 };
}
async function runSessions(run: WorkflowRun): Promise<[string, SessionTime][]> {
  const root = join(run.dir, "sessions");
  const names = (await files(root)).filter((name) =>
    sessionFilename.test(name),
  );
  return collect(names, async (name): Promise<[string, SessionTime]> => {
    const records = sessionRecords(
      await readCap(join(root, name), sourceReadBytes, true),
    ).filter((record) => today(record.message.timestamp ?? record.timestamp));
    return [`${run.repo}#${run.issue}/${basename(name)}`, sessionTime(records)];
  });
}
async function sessions(
  runs: WorkflowRun[],
): Promise<Record<string, SessionTime>> {
  const entries = await collect(
    runs.filter((run) => run.data.history !== true),
    runSessions,
  );
  return Object.fromEntries(entries.flat());
}

export { observeWebGate, runningGate, sessionRecords, sessions, webProcesses };
