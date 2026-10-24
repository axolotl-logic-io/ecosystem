// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import "./isolated-root-test-kit.mjs";

test("the standalone seam builds but default runtime entry points cannot reach either factory", async () => {
  const source = path.resolve(import.meta.dirname, "../src");
  const defaults = await build({
    entryPoints: ["job.ts", "ops.ts", "orchestrate.ts", "report.ts"].map(
      (entry) => path.join(source, entry),
    ),
    bundle: true,
    write: false,
    metafile: true,
    outdir: "unused",
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  assert.equal(
    Object.keys(defaults.metafile.inputs).some(
      (input) =>
        input.endsWith("/execution.ts") ||
        input.endsWith("/coordination.ts") ||
        input.endsWith("/execution-state.ts") ||
        input.endsWith("/execution-history.ts"),
    ),
    false,
  );
});
