// @ts-check
// IPC start barrier for real competing ops processes, with no timed waits.
import fs from "node:fs";
import process from "node:process";
import { z } from "zod";

const CRASH_CODE = 23;
const HOUR_MS = 3_600_000;
const [file, mode, number] = z
  .tuple([
    z.string(),
    z.enum(["claim", "crash", "prune", "pending"]),
    z.coerce.number().int().positive(),
  ])
  .parse(process.argv.slice(2));
const { loadConfig, paths } = await import("../src/config.ts");
const {
  checkoutEnvironment,
  pruneLaneResources,
  withCheckoutSetup,
  withCheckoutSlot,
} = await import("../src/lane-slots.ts");
const cfg = loadConfig(file);
process.once("message", () => {
  try {
    if (mode === "prune") {
      pruneLaneResources(cfg, () => HOUR_MS);
      process.send?.({ pruned: true });
    } else {
      const slot = withCheckoutSlot(cfg, number, () => {
        fs.mkdirSync(paths.worktree(cfg, number), { recursive: true });
        return checkoutEnvironment(cfg, number).get("ISSUE_PIPELINE_LANE_SLOT");
      });
      if (mode === "crash") {
        process.exit(CRASH_CODE);
      }
      if (mode === "pending") {
        fs.writeFileSync(
          `${paths.worktree(cfg, number)}/local-work`,
          "original\n",
        );
        withCheckoutSetup(cfg, number, paths.worktree(cfg, number), () =>
          process.exit(CRASH_CODE),
        );
      }
      process.send?.({ slot });
    }
  } catch (error) {
    process.send?.({ error: String(error) });
  }
  process.disconnect();
});
process.send?.({ ready: true });
