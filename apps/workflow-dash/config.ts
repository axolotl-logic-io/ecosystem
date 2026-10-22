import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

const repositoryName = /^[\w][\w.-]*\/[\w][\w.-]*$/u;
const optionalPath = z.string().optional().catch(undefined);
const settingsSchema = z.object({
  runs: optionalPath,
  installed: optionalPath,
  hold: optionalPath,
  plan: optionalPath,
  buddyRuns: optionalPath,
  agentRuns: optionalPath,
  operators: optionalPath,
  repos: z.array(z.string().regex(repositoryName)).optional().catch(undefined),
  mainRepo: z.string().regex(repositoryName).optional().catch(undefined),
});

interface Config {
  runs: string;
  installed: string;
  hold: string;
  plan: string;
  buddyRuns: string;
  repos: string[];
  mainRepo: string;
}

const defaults: Config = {
  runs: join(homedir(), ".pi/agent/issue-pipeline/runs"),
  installed: join(homedir(), ".pi/agent/issue-pipeline/INSTALLED.json"),
  hold: join(
    homedir(),
    "workspace/agent-handoffs/project-buddy/20261019-launch-ready/CUTOVER-HOLD",
  ),
  plan: join(homedir(), "brain/plans/issue-pipeline.md"),
  buddyRuns: join(
    tmpdir(),
    `pi-subagents-uid-${process.getuid?.() ?? "unknown"}`,
    "async-subagent-runs",
  ),
  repos: ["axolotl-logic-io/ecosystem", "axolotl-logic-io/project-buddy"],
  mainRepo: "axolotl-logic-io/ecosystem",
};

function configure(input: unknown): Config {
  const parsed = settingsSchema.safeParse(input);
  const out = { ...defaults, repos: [...defaults.repos] };
  if (!parsed.success) {
    return out;
  }
  const settings = parsed.data;
  const paths = {
    runs: settings.runs,
    installed: settings.installed,
    hold: settings.hold,
    plan: settings.plan,
    buddyRuns: settings.buddyRuns ?? settings.agentRuns ?? settings.operators,
  };
  for (const [key, value] of Object.entries(paths)) {
    if (value !== undefined) {
      let path = resolve(value);
      if (value.startsWith("~/")) {
        path = join(homedir(), value.slice(2));
      }
      Object.assign(out, { [key]: path });
    }
  }
  if (settings.repos !== undefined) {
    out.repos = settings.repos;
  }
  if (settings.mainRepo !== undefined) {
    out.mainRepo = settings.mainRepo;
  }
  return out;
}

export type { Config };
export { configure, defaults };
