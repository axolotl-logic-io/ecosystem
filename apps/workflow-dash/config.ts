import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

const repositoryName = /^[\w][\w.-]*\/[\w][\w.-]*$/u;
const settingsSchema = z.strictObject({
  subagentRuns: z.string().min(1).optional(),
  repos: z.array(z.string().regex(repositoryName)).min(1).optional(),
});

interface Config {
  /** The generic pi-subagents run records. */
  subagentRuns: string;
  repos: string[];
}

const defaults: Config = {
  subagentRuns: join(
    tmpdir(),
    `pi-subagents-uid-${process.getuid?.() ?? "unknown"}`,
    "async-subagent-runs",
  ),
  repos: ["axolotl-logic-io/ecosystem", "axolotl-logic-io/project-buddy"],
};

function expand(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

/** The dashboard's settings; throws when `input` is not valid settings. */
function configure(input: unknown): Config {
  const settings = settingsSchema.parse(input);
  let { subagentRuns } = defaults;
  if (settings.subagentRuns !== undefined) {
    subagentRuns = expand(settings.subagentRuns);
  }
  return { subagentRuns, repos: settings.repos ?? [...defaults.repos] };
}

/**
 * The runs folder that task apps write under the data root
 * `ECOSYSTEM_DATA_ROOT`; throws when that is unset or relative.
 */
function runsFolder(dataRoot: string | undefined): string {
  if (dataRoot === undefined || !isAbsolute(dataRoot)) {
    throw new Error("ECOSYSTEM_DATA_ROOT must name an absolute directory");
  }
  return join(dataRoot, "runs");
}

export type { Config };
export { configure, defaults, runsFolder };
