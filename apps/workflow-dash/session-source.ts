import { homedir } from "node:os";
import { join } from "node:path";
import { processList } from "./process-observations.ts";

const webRunner = /\b(?:playwright|vitest|next(?:-server)?)\b/u;
const excludedProcess = /\b(?:grep|capture-pane)\b/u;
const issuePath = /(?:issue-|issue\/)(?<issue>\d+)\b/gu;
const projectBuddyWork = join(
  homedir(),
  ".pi/agent/issue-pipeline/work/axolotl-logic-io__project-buddy",
);

function webProcesses(text: string): string[] {
  return text
    .split("\n")
    .filter(
      (line) =>
        webRunner.test(line) &&
        (line.includes(`${projectBuddyWork}/`) ||
          line.endsWith(projectBuddyWork)) &&
        !excludedProcess.test(line),
    );
}
/**
 * Project Buddy web-runner processes running in a pipeline checkout, and the
 * issues their paths name. Positive activity only: no process found is not
 * an available scope.
 */
async function observeWebGate(
  processRead: () => Promise<string> = processList,
): Promise<{ issues: number[]; busy: boolean }> {
  const processes = webProcesses(await processRead());
  const issues = new Set<number>();
  for (const line of processes) {
    for (const match of line.matchAll(issuePath)) {
      const { issue } = match.groups ?? {};
      issues.add(Number(issue));
    }
  }
  return { issues: [...issues], busy: processes.length > 0 };
}

export { observeWebGate };
