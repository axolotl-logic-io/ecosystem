import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

const repositoryName = /^[\w][\w.-]*\/[\w][\w.-]*$/u;
const optionalPath = z.string().optional().catch(undefined);
/** Deprecated names of `subagentRuns`, in precedence order. */
const subagentRunAliases = ["buddyRuns", "agentRuns", "operators"] as const;
const settingsSchema = z.object({
  runs: optionalPath,
  installed: optionalPath,
  hold: optionalPath,
  plan: optionalPath,
  subagentRuns: optionalPath,
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
  /** The generic pi-subagents run records; not domain buddy runs. */
  subagentRuns: string;
  repos: string[];
  mainRepo: string;
  /** Deprecated or conflicting settings, reported as coverage warnings. */
  warnings: string[];
}

const defaults: Config = {
  runs: join(homedir(), ".pi/agent/issue-pipeline/runs"),
  installed: join(homedir(), ".pi/agent/issue-pipeline/INSTALLED.json"),
  hold: join(
    homedir(),
    "workspace/agent-handoffs/project-buddy/20261019-launch-ready/CUTOVER-HOLD",
  ),
  plan: join(homedir(), "brain/plans/issue-pipeline.md"),
  subagentRuns: join(
    tmpdir(),
    `pi-subagents-uid-${process.getuid?.() ?? "unknown"}`,
    "async-subagent-runs",
  ),
  repos: ["axolotl-logic-io/ecosystem", "axolotl-logic-io/project-buddy"],
  mainRepo: "axolotl-logic-io/ecosystem",
  warnings: [],
};

function expand(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

/**
 * The first of `subagentRuns` and its deprecated aliases that is set. Each
 * alias in use, and each one naming another directory, becomes a warning;
 * competing directories are never merged.
 */
function subagentRunsSetting(settings: z.infer<typeof settingsSchema>): {
  value: string | undefined;
  warnings: string[];
} {
  const set = (["subagentRuns", ...subagentRunAliases] as const).flatMap(
    (key) => {
      const value = settings[key];
      if (value === undefined) {
        return [];
      }
      return [{ key, path: expand(value) }];
    },
  );
  const [chosen] = set;
  const warnings = set.flatMap(({ key, path }) => {
    if (key === "subagentRuns") {
      return [];
    }
    if (chosen !== undefined && path !== chosen.path) {
      return [
        `Configuration key ${key} is deprecated and names ${path}, not ${chosen.path}; ${chosen.key} takes precedence.`,
      ];
    }
    return [`Configuration key ${key} is deprecated; use subagentRuns.`];
  });
  return { value: chosen?.path, warnings };
}

function configure(input: unknown): Config {
  const parsed = settingsSchema.safeParse(input);
  const out: Config = { ...defaults, repos: [...defaults.repos], warnings: [] };
  if (!parsed.success) {
    return out;
  }
  const settings = parsed.data;
  const subagentRuns = subagentRunsSetting(settings);
  const paths = {
    runs: settings.runs,
    installed: settings.installed,
    hold: settings.hold,
    plan: settings.plan,
  };
  for (const [key, value] of Object.entries(paths)) {
    if (value !== undefined) {
      Object.assign(out, { [key]: expand(value) });
    }
  }
  if (subagentRuns.value !== undefined) {
    out.subagentRuns = subagentRuns.value;
  }
  out.warnings = subagentRuns.warnings;
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
