#!/usr/bin/env node
// Operator-only reconciliation; unlike job.mjs this never launches a stage.
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { adoptLegacy } from "./adoption.ts";
import { loadConfig } from "./config.ts";

function main(): void {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: "string" },
        issue: { type: "string" },
        branch: { type: "string" },
        "code-path": { type: "string" },
        "wiki-path": { type: "string" },
        "restart-stage": { type: "string" },
      },
    });
    const request = z
      .object({
        config: z.string().min(1),
        issue: z.coerce.number().int().positive(),
        branch: z.string().min(1),
        "code-path": z.string().min(1),
        "wiki-path": z.string().optional(),
        "restart-stage": z.string().optional(),
      })
      .parse(values);
    const result = adoptLegacy(loadConfig(request.config), {
      issue: request.issue,
      branch: request.branch,
      code: request["code-path"],
      wiki: request["wiki-path"],
      restart: request["restart-stage"],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      ({ message } = error);
    }
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  }
}

main();
