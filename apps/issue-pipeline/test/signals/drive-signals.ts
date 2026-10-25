// The signal tests' driver process: loads the config named by its first
// argument and runs one inbox call named by its second, printing the result
// as JSON. It runs with fake-tasks-hook.ts imported and the fake gh first on
// PATH, as signal-test-kit.ts starts it.
import process from "node:process";
import { z } from "zod";
import { loadConfig } from "../../src/config.ts";
import {
  pollSignals,
  requalify,
  requalifyHumanNow,
  stopLatch,
  stopLatchNow,
} from "../../src/signals/inbox.ts";

const REQUEST = z.discriminatedUnion("call", [
  z.strictObject({
    call: z.literal("poll"),
    organization: z.string(),
    buddyRun: z.string(),
  }),
  z.strictObject({
    call: z.literal("requalify"),
    organization: z.string(),
    // Passed through as the runtime would; requalify checks it afresh.
    signal: z.custom<Parameters<typeof requalify>[2]>(),
  }),
  z.strictObject({
    call: z.literal("requalify-now"),
    organization: z.string(),
    source: z.custom<Parameters<typeof requalifyHumanNow>[2]>(),
  }),
  z.strictObject({ call: z.literal("latch"), number: z.number() }),
  z.strictObject({ call: z.literal("latch-now"), number: z.number() }),
]);

async function main(): Promise<unknown> {
  const cfg = loadConfig(process.argv[2]);
  const request = REQUEST.parse(JSON.parse(process.argv[3] ?? ""));
  if (request.call === "poll") {
    return await pollSignals(
      cfg,
      { organization: request.organization },
      request.buddyRun,
    );
  }
  if (request.call === "requalify") {
    return await requalify(
      cfg,
      { organization: request.organization },
      request.signal,
    );
  }
  if (request.call === "requalify-now") {
    return requalifyHumanNow(
      cfg,
      { organization: request.organization },
      request.source,
    );
  }
  if (request.call === "latch-now") {
    return stopLatchNow(cfg, request.number);
  }
  return await stopLatch(cfg, request.number);
}

process.stdout.write(`${JSON.stringify(await main())}\n`);
