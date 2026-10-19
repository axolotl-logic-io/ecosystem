// @ts-check
// A restartable source-op process in the parent's isolated world. Preserve
// its private clone slug as well as the configured repository/checkout.
import process from "node:process";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { loadConfig, withCheckout } from "../src/config.ts";
import { merge } from "../src/ops/merge.ts";
import { reconcileMerge } from "../src/ops/merge-recovery.ts";

const REQUEST = z.object({
  config: z.string(),
  slug: z.string(),
  checkout: z.object({
    issue: z.number(),
    dir: z.string(),
    branch: z.string(),
  }),
  op: z.enum(["merge", "reconcile-merge"]),
  payload: z.unknown(),
});
const req = REQUEST.parse(JSON.parse(await text(process.stdin)));
const cfg = {
  ...withCheckout(loadConfig(req.config), req.checkout),
  slug: req.slug,
};
let reply;
if (req.op === "merge") {
  reply = merge(cfg, req.payload);
} else {
  reply = reconcileMerge(cfg, req.payload);
}
process.stdout.write(JSON.stringify({ ok: true, ...reply }));
