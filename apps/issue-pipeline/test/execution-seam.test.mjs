// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { z } from "zod";
import { configFixture } from "./config-fixtures.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

// Resolve the pipeline root only after the isolation kit has run, independent
// of import sorting. No test may load the operator's installed root.
const { loadConfig } = await import("../src/config.ts");
const { executionIdentity, issueExecution, withExecution } = await import(
  "../src/execution.ts"
);

const cfg = configFixture({ assignment: undefined });
const ISSUE = 7;
const HELD = /binding|reconciliation/u;

test("fresh executions on one stable lane bind unique UUIDs to the exact configured scope", () => {
  const a = executionIdentity(cfg, ISSUE, "caller");
  const b = executionIdentity(cfg, ISSUE, "caller");
  assert.notEqual(a.instance, b.instance);
  assert.equal(z.string().uuid().parse(a.instance), a.instance);
  assert.equal(z.string().uuid().parse(b.instance), b.instance);
  assert.deepEqual({ ...a, instance: b.instance }, b);
  assert.equal(a.repo, cfg.repo);
  assert.equal(a.base, cfg.baseBranch);
  assert.equal(a.issue, ISSUE);
  assert.equal(a.branch, "agent/issue-7");
});

for (const change of [
  { issue: 8 },
  { branch: "other" },
  { repo: "other/repo" },
  { base: "main" },
]) {
  test(`a factory refuses changed execution binding ${JSON.stringify(change)}`, () => {
    const execution = executionIdentity(cfg, ISSUE, "caller");
    assert.throws(
      () =>
        issueExecution(
          { ...cfg, execution: { ...execution, ...change } },
          ISSUE,
        ),
      HELD,
    );
  });
}

test("execution UUID and lane validation are not inherited from a permissive config", () => {
  const execution = executionIdentity(cfg, ISSUE, "caller");
  assert.throws(() => withExecution(cfg, { ...execution, instance: "caller" }));
  assert.throws(() => executionIdentity(cfg, ISSUE, ""));
  assert.throws(() => issueExecution(cfg, ISSUE));
});

test("repository JSON cannot activate an internal execution or mutation hook", () => {
  const file = path.join(isolatedRoot, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...cfg,
      execution: executionIdentity(cfg, ISSUE, "caller"),
      mutation: "not an internal callback",
    }),
  );
  const loaded = loadConfig(file);
  assert.equal(loaded.execution, undefined);
  assert.equal(loaded.mutation, undefined);
});

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
