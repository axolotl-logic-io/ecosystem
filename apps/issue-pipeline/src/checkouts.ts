// Run configured setup in a task's private checkout.
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { shell } from "./process.ts";

const MS_PER_MINUTE = 60_000;
// The config keys setUpCheckout reads; loadConfig applied their defaults.
const SETUP_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});

function setUpCheckout(
  cfg: Config,
  n: number,
  dir: string,
  logName: string,
): void {
  const { commandTimeoutMinutes, commands } = SETUP_SETTINGS.parse(cfg);
  const { setup } = commands;
  if (setup === undefined || setup === null || setup === "") {
    return;
  }
  const log = path.join(paths.runDir(cfg, n), logName);
  const result = shell(setup, dir, log, {
    timeoutMs: commandTimeoutMinutes * MS_PER_MINUTE,
  });
  if (result.code !== 0) {
    throw new OpsError(
      `#${n} setup failed (exit ${result.code}); its checkout is not prepared`,
    );
  }
}

export { setUpCheckout };
