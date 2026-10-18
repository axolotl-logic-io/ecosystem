// A session's usage tally: what one session spent, measured from the
// records it prints. It is telemetry only: nothing limits a session by it
// (`no-session-budgets`). It does no I/O.

import { recordFacts } from "./raw-results.ts";
import type { Usage } from "./token-usage.ts";
import { addUsage, turnContext, ZERO_USAGE } from "./token-usage.ts";

interface ToolUse {
  calls: number;
  outputChars: number;
}

interface ToolOutput {
  tool: string;
  chars: number;
}

// What one session spent: assistant turns with usage, tokens, the first,
// highest and last turn's context, each tool's calls and output, the largest
// single output, and the seconds it ran.
interface LaunchUsage {
  turns: number;
  tokens: Usage;
  first: number;
  peak: number;
  atFinish: number;
  tools: Readonly<Record<string, ToolUse>>;
  largest: ToolOutput | null;
  seconds: number;
}

// A session's tally, fed every record it prints.
interface UsageTally {
  record: (record: unknown) => void;
  usage: (seconds: number) => LaunchUsage;
}

interface Tally {
  turns: number;
  tokens: Usage;
  first: number | null;
  peak: number;
  atFinish: number;
  tools: Map<string, ToolUse>;
  largest: ToolOutput | null;
}

function addRecord(tally: Tally, record: unknown): void {
  const { usage, toolEnd } = recordFacts(record);
  if (usage !== null) {
    const context = turnContext(usage);
    tally.turns += 1;
    tally.tokens = addUsage(tally.tokens, usage);
    tally.first ??= context;
    tally.peak = Math.max(tally.peak, context);
    tally.atFinish = context;
  }
  if (toolEnd !== null) {
    const { tool, outputChars } = toolEnd;
    const use = tally.tools.get(tool) ?? { calls: 0, outputChars: 0 };
    tally.tools.set(tool, {
      calls: use.calls + 1,
      outputChars: use.outputChars + outputChars,
    });
    if (outputChars > (tally.largest?.chars ?? -1)) {
      tally.largest = { tool, chars: outputChars };
    }
  }
}

// A fresh tally for one session.
function usageTally(): UsageTally {
  const tally: Tally = {
    turns: 0,
    tokens: ZERO_USAGE,
    first: null,
    peak: 0,
    atFinish: 0,
    tools: new Map(),
    largest: null,
  };
  return {
    record: (record: unknown): void => {
      addRecord(tally, record);
    },
    usage: (seconds: number): LaunchUsage => ({
      turns: tally.turns,
      tokens: tally.tokens,
      first: tally.first ?? 0,
      peak: tally.peak,
      atFinish: tally.atFinish,
      tools: Object.fromEntries(tally.tools),
      largest: tally.largest,
      seconds,
    }),
  };
}

export type { LaunchUsage, ToolOutput, ToolUse, UsageTally };
export { usageTally };
