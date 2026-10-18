// The results of the sweep's launches as a stage reads them: an ops reply
// parsed from the ops child's output, and a session's result signed with its
// launch's role, its reported tokens counted into the issue's state.

import { rateTokens } from "./rate-tokens.ts";
import type { LaunchMeta } from "./signing.ts";
import { by } from "./signing.ts";
import { isRecord } from "./stages/reply-guards.ts";
import type { ChildLaunch, Launch, LaunchResult } from "./stages/types.ts";
import type { IssueState } from "./types.ts";

type Reply = Readonly<Record<string, unknown>>;

// How much of an ops child's output a reply that wasn't JSON keeps.
const OUTPUT_TAIL = 500;

// The text, or null when it is missing, empty or not text.
function textOf(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return null;
}

// The ops reply in a finished ops child's output: the last line that is a
// JSON object, scanning up from the end and stopping at the first line that
// opens like one but doesn't parse.
function parseOps(raw: unknown): Reply {
  let result: Reply = {};
  if (isRecord(raw)) {
    result = raw;
  }
  const { ok, error, output } = result;
  if (ok !== true) {
    return {
      ok: false,
      error: `ops child failed: ${textOf(error) ?? "no detail"}`,
    };
  }
  const text = textOf(output) ?? "";
  const lines = text.trim().split("\n");
  for (const line of lines.reverse().map((entry) => entry.trim())) {
    if (line.startsWith("{")) {
      const parsed = parsedLine(line);
      if (parsed === null) {
        break;
      }
      return parsed;
    }
  }
  return {
    ok: false,
    error: `ops reply was not JSON: ${text.slice(-OUTPUT_TAIL)}`,
  };
}

// The line as a JSON object, or null if it isn't one.
function parsedLine(line: string): Reply | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// The tokens a session's result reports spending (rateTokens: cache reads
// left out), or null when it reports no usage.
function usageTokens(raw: Reply): number | null {
  const { results } = raw;
  if (!Array.isArray(results)) {
    return null;
  }
  const [first]: unknown[] = results;
  if (!isRecord(first)) {
    return null;
  }
  const { usage } = first;
  if (!isRecord(usage)) {
    return null;
  }
  const { input, output, cacheRead, cacheWrite } = usage;
  return rateTokens({
    input: countOf(input),
    output: countOf(output),
    cacheRead: countOf(cacheRead),
    cacheWrite: countOf(cacheWrite),
  });
}

// A usage count, or 0 when it isn't a number.
function countOf(count: unknown): number {
  if (typeof count === "number") {
    return count;
  }
  return 0;
}

// The fields of a session's result its signature reads, each only if it is text.
function signedFields(raw: Reply): {
  key?: string;
  agent?: string;
  runId?: string;
} {
  const fields: { key?: string; agent?: string; runId?: string } = {};
  const { key, agent, runId } = raw;
  if (typeof key === "string") {
    fields.key = key;
  }
  if (typeof agent === "string") {
    fields.agent = agent;
  }
  if (typeof runId === "string") {
    fields.runId = runId;
  }
  return fields;
}

// A session's result as its stage reads it, signed with its launch's role.
// The tokens it reports spending are added to the state's reportedTokens.
function childResult(
  launch: ChildLaunch,
  raw: unknown,
  st: IssueState,
  meta: Readonly<Record<string, LaunchMeta>>,
): LaunchResult {
  const role = textOf(launch.role) ?? launch.name;
  if (!isRecord(raw)) {
    const signed = by(meta, null, role);
    return {
      kind: "child",
      ok: false,
      structuredOutput: null,
      error: null,
      by: signed,
    };
  }
  const tokens = usageTokens(raw);
  if (tokens !== null) {
    st.reportedTokens = (st.reportedTokens ?? 0) + tokens;
  }
  const { ok, structuredOutput, error } = raw;
  return {
    kind: "child",
    ok: ok === true,
    structuredOutput: structuredOutput ?? null,
    error: textOf(error),
    by: by(meta, signedFields(raw), role),
  };
}

// The launches' results, in launch order, as a stage reads them.
function launchResults(
  launches: readonly Launch[],
  raw: readonly unknown[],
  st: IssueState,
  meta: Readonly<Record<string, LaunchMeta>>,
): LaunchResult[] {
  return launches.map((launch, index): LaunchResult => {
    const result = raw[index];
    if (launch.kind === "op") {
      return { kind: "op", reply: parseOps(result) };
    }
    return childResult(launch, result, st, meta);
  });
}

export { launchResults, parseOps };
