// Bounded retries for safe GitHub reads only. Callers may further restrict
// retry eligibility (identity rejection must take precedence over transport text).
import type { RunResult } from "./process.ts";
import { sleepMs } from "./process.ts";

const GH_TIMEOUT_MS = 120_000;
const GH_READ_ATTEMPTS = 4;
const GH_RETRY_STEP_MS = 2000;
const GH_TRANSIENT =
  /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Timeout|connection (?:reset|refused|error)|error connecting to|could not resolve host|no such host|network is unreachable|TLS handshake timeout|i\/o timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|secondary rate limit/iu;

function transientGithubRead(result: RunResult): boolean {
  return (
    result.code !== 0 && (result.timedOut || GH_TRANSIENT.test(result.stderr))
  );
}

function githubRead(
  read: () => RunResult,
  mayRetry: (result: RunResult) => boolean = transientGithubRead,
): { result: RunResult; attempts: number } {
  let attempts = 1;
  let result = read();
  while (attempts < GH_READ_ATTEMPTS && mayRetry(result)) {
    sleepMs(GH_RETRY_STEP_MS * attempts);
    attempts += 1;
    result = read();
  }
  return { result, attempts };
}

export { GH_TIMEOUT_MS, githubRead, transientGithubRead };
