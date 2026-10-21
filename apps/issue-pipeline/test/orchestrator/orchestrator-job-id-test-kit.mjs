// @ts-check
// The job id the orchestrator passes each job it spawns with --job-id
// (src/orchestrator/start-job.ts), as orchestrator.log's start line names it.
import { z } from "zod";

const JOB_ID = z.uuid();

/** @param {readonly string[]} argv @returns {string} the --job-id it passes, a UUID */
function jobIdOf(argv) {
  const at = argv.indexOf("--job-id");
  if (at < 0) {
    throw new Error(`no --job-id in ${argv.join(" ")}`);
  }
  return JOB_ID.parse(argv[at + 1]);
}

/** @param {readonly string[]} argv @returns {string[]} argv less its --job-id */
function withoutJobId(argv) {
  const at = argv.indexOf("--job-id");
  if (at < 0) {
    return [...argv];
  }
  return [...argv.slice(0, at), ...argv.slice(at + 2)];
}

export { jobIdOf, withoutJobId };
