// The job id the orchestrator passes each job it spawns with --job-id
// (src/orchestrator/start-job.ts), as orchestrator.log's start line names it.
import { z } from "zod";

const JOB_ID = z.uuid();

// Returns the --job-id it passes, a UUID
function jobIdOf(argv: readonly string[]): string {
  const at = argv.indexOf("--job-id");
  if (at < 0) {
    throw new Error(`no --job-id in ${argv.join(" ")}`);
  }
  return JOB_ID.parse(argv[at + 1]);
}

// Returns argv less its --job-id
function withoutJobId(argv: readonly string[]): string[] {
  const at = argv.indexOf("--job-id");
  if (at < 0) {
    return [...argv];
  }
  return [...argv.slice(0, at), ...argv.slice(at + 2)];
}

export { jobIdOf, withoutJobId };
