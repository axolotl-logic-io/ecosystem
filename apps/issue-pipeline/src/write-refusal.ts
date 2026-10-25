// What a failed credentialed write proves (#169, `observation-sources`). A
// write is refused only when the system it targets answered no: GitHub with
// a 4xx status other than a timeout or rate limit, or a Git remote that
// rejected the ref. Nothing changed, so its journaled intent can be cleared.
// Every other failure, such as a 5xx, a dropped connection or a timeout, may
// hide a write that landed, so its result is unknown.

import type { RunResult } from "./process.ts";

// The command and arguments a write runs, journaled before it runs unless
// its own operation reconciles it (github.ts's `reconciles`). Bodies are
// already redacted (redactGhArgs); tokens never appear in arguments.
interface WriteIntent {
  command: "gh" | "git";
  args: readonly string[];
  journal: boolean;
}

// A 4xx status, but not 408 (timeout) or 429 (rate limit).
const GITHUB_REFUSAL = /\bHTTP 4(?!08\b|29\b)\d\d\b/u;
const GIT_REFUSAL = /\[(?:remote )?rejected\]|\(stale info\)/u;

function refusedWrite(intent: WriteIntent, result: RunResult): boolean {
  if (result.code === 0 || result.timedOut) {
    return false;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (intent.command === "git") {
    return GIT_REFUSAL.test(output);
  }
  return GITHUB_REFUSAL.test(output);
}

export type { WriteIntent };
export { refusedWrite };
