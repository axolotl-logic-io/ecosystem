// What a session spent, as pi reports it on each assistant message: its
// token counts, the part of its cache writes that lasts an hour, and its
// cost. This module alone knows pi's shape for it and how usages add up.

import { z } from "zod";

// Token counts, the part of the cache writes that lasts an hour (the rest
// lasts five minutes), and the cost in US dollars, as pi prices the model.
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cost: number;
}

const COUNT = z.number().catch(0);
const TOKEN_COUNTS = z.object({
  input: COUNT,
  output: COUNT,
  cacheRead: COUNT,
  cacheWrite: COUNT,
  cacheWrite1h: COUNT,
});
// A usage as job.json keeps it; a count an older file lacks reads as 0.
const USAGE = TOKEN_COUNTS.extend({ cost: COUNT });
// An assistant message's usage as pi prints it, whose `cost` is a breakdown
// with its `total`.
const PI_USAGE = TOKEN_COUNTS.extend({
  cost: z.object({ total: COUNT }).catch({ total: 0 }),
}).transform(({ cost, ...counts }): Usage => ({ ...counts, cost: cost.total }));

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
};

// The two usages summed.
function addUsage(sum: Usage, usage: Usage): Usage {
  return {
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
    cacheWrite1h: sum.cacheWrite1h + usage.cacheWrite1h,
    cost: sum.cost + usage.cost,
  };
}

// Every token the usage counts: input, output and both cache counts.
function usageTotal(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export type { Usage };
export { addUsage, PI_USAGE, USAGE, usageTotal, ZERO_USAGE };
