// The tokens the pipeline counts as a session's spend: input, output and
// cache writes. Cache reads are left out: every call re-reads the cached
// context, so they would dwarf the rest. The orchestrator's hourly rate limit
// (ledger.ts) and the issue's reportedTokens (launch-results.ts) count these;
// context measures (`usageTotal`, `turnContext`) still count cache reads.

// A session's token counts, as its usage reports them.
interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function rateTokens(usage: TokenCounts): number {
  return usage.input + usage.output + usage.cacheWrite;
}

export type { TokenCounts };
export { rateTokens };
