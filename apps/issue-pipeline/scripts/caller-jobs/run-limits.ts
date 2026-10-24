// The caller's run limits: `run.json` in the run folder, which the caller
// writes once from Autumn's inputs, and `jobs/limits.json`, a copy of its
// caps as the run's first start read them. Every later start is held to
// that copy, so a caller may narrow its caps but never widen them.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { JOB_TASKS } from "../../src/job/task-request.ts";
import { STAGES } from "../../src/stages.ts";

const RUN_FILE = "run.json";
const FIRST_LIMITS_FILE = path.join("jobs", "limits.json");

const COUNT = z.number().int().positive();
// What a job works on, for its caps and attempts: a stage, or a task a job
// was asked to run (#186), which counts apart from its stage's jobs.
const WORK = [...STAGES, ...JOB_TASKS] as const;
// The run's limits, which Autumn sets for each run. modelEnvFile is a path
// the job's Node loads with --env-file; this module never opens it.
const RUN = z.strictObject({
  maxJobs: COUNT,
  maxStageJobs: z.partialRecord(z.enum(WORK), COUNT).default({}),
  maxAttempts: COUNT,
  excludedIssues: z.record(z.string(), z.array(COUNT)).default({}),
  modelEnvFile: z.string().startsWith("/").optional(),
});
// The caps run.json had at the run's first start. It leaves out
// modelEnvFile, so only run.json names that file.
const FIRST_LIMITS = RUN.omit({ modelEnvFile: true });

type RunLimits = z.infer<typeof RUN>;
type FirstLimits = z.infer<typeof FIRST_LIMITS>;

// `value` as `schema` reads it, or a throw naming `what` and what doesn't fit.
function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// The text of `file`, or null when there is no such file.
function textOf(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function runLimits(runDir: string): RunLimits {
  const file = path.join(runDir, RUN_FILE);
  return parsed(RUN, JSON.parse(textOf(file) ?? "null"), file);
}

// The caps the run's first start read, kept the first time this is asked.
function firstLimits(runDir: string, limits: RunLimits): FirstLimits {
  const file = path.join(runDir, FIRST_LIMITS_FILE);
  const kept = textOf(file);
  if (kept !== null) {
    return parsed(FIRST_LIMITS, JSON.parse(kept), file);
  }
  const { modelEnvFile: _modelEnvFile, ...caps } = limits;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(caps, null, 2)}\n`);
  return caps;
}

// How `limits` widen the caps the run's first start read, or null when they
// don't: a higher maxJobs, maxAttempts or stage cap, a stage cap removed,
// or an issue no longer excluded.
function wideningOf(runDir: string, limits: RunLimits): string | null {
  const first = firstLimits(runDir, limits);
  const caps: [string, number, number | undefined][] = [
    ["maxJobs", first.maxJobs, limits.maxJobs],
    ["maxAttempts", first.maxAttempts, limits.maxAttempts],
  ];
  for (const work of WORK) {
    const cap = first.maxStageJobs[work];
    if (cap !== undefined) {
      caps.push([`maxStageJobs.${work}`, cap, limits.maxStageJobs[work]]);
    }
  }
  for (const [name, was, now] of caps) {
    if (now === undefined || now > was) {
      return `run.json raises ${name} past the run's first limit, ${was}`;
    }
  }
  for (const [repo, issues] of Object.entries(first.excludedIssues)) {
    const kept = limits.excludedIssues[repo] ?? [];
    const dropped = issues.find((issue) => !kept.includes(issue));
    if (dropped !== undefined) {
      return `run.json no longer excludes ${repo}#${dropped}`;
    }
  }
  return null;
}

export type { RunLimits };
export { COUNT, parsed, runLimits, WORK, wideningOf };
