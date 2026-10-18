// @ts-check
// Loaded with `NODE_OPTIONS=--import=<this file>` before a stage job, so its
// `spec` stage runs a toy linear role instead of the sweep: it posts once,
// then ends with the issue saved at `implement`. Its hand-off is `note`, its
// checkpoint `count`, and `scratch` is data no save may carry.
import { linearRole, registerRole } from "../src/roles/registry.ts";

/** @typedef {{ note: string, count: number, scratch: string }} PreloadData */

registerRole(
  "spec",
  linearRole("spec-writer", {
    locate: () => ({
      at: "announce",
      data: { note: "noted", count: 1, scratch: "never saved" },
    }),
    steps: [
      {
        name: "announce",
        kind: "script",
        effect: () => ({ kind: "op", op: "post", payload: { body: "Toy" } }),
      },
    ],
    end: () => ({ kind: "saved", stage: "implement" }),
    handoff: ["note"],
    checkpoints: ["count"],
  }),
);
