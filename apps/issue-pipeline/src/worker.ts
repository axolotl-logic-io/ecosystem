#!/usr/bin/env node
// Opt-in assignment runtime. Source delivery never starts this program.
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { poll } from "./assignment/poll.ts";
import { runtimeDeps } from "./assignment/runtime.ts";
import { readManifest } from "./assignment/scope.ts";
import { workerOf } from "./assignment/signals.ts";
import { loadConfig } from "./config.ts";
import { OpsError } from "./ops-error.ts";

const ARGS = z.object({
  manifest: z.string().min(1),
  worker: z.string().min(1),
  once: z.boolean().default(false),
});
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      worker: { type: "string" },
      once: { type: "boolean" },
    },
  });
  const args = ARGS.parse(values);
  const manifest = readManifest(args.manifest);
  const controller = new AbortController();
  function stop(): void {
    controller.abort();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const repositories = manifest.repositories.map((entry) => {
      const cfg = loadConfig(entry.config);
      workerOf(cfg, args.worker);
      const repository = { ...entry, manifest: args.manifest, cfg };
      return {
        cfg,
        deps: runtimeDeps(repository, args.worker, controller.signal),
      };
    });
    if (
      new Set(repositories.map(({ cfg }) => cfg.repo.toLowerCase())).size !==
      repositories.length
    ) {
      throw new OpsError("ambiguous repository mapping in worker allow-list");
    }
    await poll(
      repositories,
      args.worker,
      {
        now: (): number => Date.now(),
        stopped: (): boolean => controller.signal.aborted,
        sleep: async (ms: number): Promise<void> => {
          try {
            await delay(ms, undefined, { signal: controller.signal });
          } catch (error: unknown) {
            if (!controller.signal.aborted) {
              throw error;
            }
          }
        },
        report: (repo: string, reason: string): void => {
          process.stderr.write(`assignment worker ${repo}: ${reason}\n`);
        },
      },
      args.once,
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
try {
  await main();
} catch (error: unknown) {
  let reason = "assignment worker failed";
  if (error instanceof Error) {
    reason = error.message;
  }
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
