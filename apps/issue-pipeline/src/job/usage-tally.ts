// A launch's usage tally: what one launch's sessions (a session and its
// retry) spent, measured from the records they print, as the context watch
// (context-watch.ts) measures context. It does no I/O.

import { turnContext } from "./context-watch.ts";
import { recordFacts } from "./raw-results.ts";
import type { Usage } from "./token-usage.ts";
import { addUsage, ZERO_USAGE } from "./token-usage.ts";

interface ToolUse {
  calls: number;
  outputChars: number;
}

interface ToolOutput {
  tool: string;
  chars: number;
}

// What one launch's sessions (a session and its retry) spent: assistant
// turns with usage, tokens, the first, highest and last turn's context,
// whether a turn passed `soft`, whether the context watch stopped the
// session whose result the launch gives, each tool's calls and output, the
// largest single output, and the seconds it ran.
interface LaunchUsage {
  turns: number;
  tokens: Usage;
  first: number;
  peak: number;
  atFinish: number;
  steered: boolean;
  stopped: boolean;
  tools: Readonly<Record<string, ToolUse>>;
  largest: ToolOutput | null;
  seconds: number;
}

// A launch's tally, fed every record its sessions print and each stop.
interface UsageTally {
  record: (key: string, record: unknown) => void;
  contextStopped: (key: string) => void;
  usage: (seconds: number) => LaunchUsage;
}

interface Tally {
  turns: number;
  tokens: Usage;
  first: number | null;
  peak: number;
  atFinish: number;
  steered: boolean;
  last: string | null;
  stops: Set<string>;
  tools: Map<string, ToolUse>;
  largest: ToolOutput | null;
}

function addRecord(tally: Tally, soft: number, record: unknown): void {
  const { usage, toolEnd } = recordFacts(record);
  if (usage !== null) {
    const context = turnContext(usage);
    tally.turns += 1;
    tally.tokens = addUsage(tally.tokens, usage);
    tally.first ??= context;
    tally.peak = Math.max(tally.peak, context);
    tally.atFinish = context;
    tally.steered ||= context > soft;
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

// A fresh tally for one launch whose sessions are held to `soft`.
function usageTally(soft: number): UsageTally {
  const tally: Tally = {
    turns: 0,
    tokens: ZERO_USAGE,
    first: null,
    peak: 0,
    atFinish: 0,
    steered: false,
    last: null,
    stops: new Set(),
    tools: new Map(),
    largest: null,
  };
  return {
    record: (key: string, record: unknown): void => {
      tally.last = key;
      addRecord(tally, soft, record);
    },
    contextStopped: (key: string): void => {
      tally.stops.add(key);
    },
    usage: (seconds: number): LaunchUsage => ({
      turns: tally.turns,
      tokens: tally.tokens,
      first: tally.first ?? 0,
      peak: tally.peak,
      atFinish: tally.atFinish,
      steered: tally.steered,
      stopped: tally.last !== null && tally.stops.has(tally.last),
      tools: Object.fromEntries(tally.tools),
      largest: tally.largest,
      seconds,
    }),
  };
}

export type { LaunchUsage, ToolOutput, ToolUse, UsageTally };
export { usageTally };
