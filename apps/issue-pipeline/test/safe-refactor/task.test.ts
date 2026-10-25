import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { snapshot } from "../job/git-review-test-kit.ts";
import { provisionFixture } from "../runtime-fixtures.ts";
import { behavior, fixture, TIMEOUT_MS } from "./refactor-test-kit.ts";
import { fakePi } from "./runtime-test-kit.ts";

const BUILD = fileURLToPath(new URL("../../build.ts", import.meta.url));
const TASK_REPORT = z.object({
  outcome: z.literal("reported"),
  runState: z.literal("ended"),
  directory: z.string(),
  needsHardening: z.literal(true),
  deliveryAuthority: z.literal(false),
  proposal: z.object({
    findings: z.array(z.object({ disposition: z.string() })),
  }),
});

test("fresh restricted task exercises real extension tools, blocks writer/shell/transform paths and cannot establish delivery authority", () => {
  const project = fixture();
  const output = path.join(project.directory, "dist");
  const build = spawnSync(process.execPath, [BUILD, output], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.equal(build.status, 0, build.stderr);
  const runtime = provisionFixture(project.directory);
  const request = { ...project.assignment, runtime };
  fs.writeFileSync(project.request, JSON.stringify(request));
  const bin = fakePi(project.directory);
  const before = behavior(project);
  const gitBefore = snapshot(path.join(project.root, ".git"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(output, "safe-refactor.mjs"),
      "run",
      "--request",
      project.request,
      "--artifacts",
      project.artifacts,
    ],
    {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["PATH", `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`],
          ["PIPELINE_MODEL_KEY", "offline-fixture-key"],
        ]),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = TASK_REPORT.parse(JSON.parse(result.stdout));
  assert.equal(behavior(project), before);
  assert.equal(snapshot(path.join(project.root, ".git")), gitBefore);
  assert.ok(report.proposal.findings.length > 0);
  assert.ok(
    report.proposal.findings.every((entry) => entry.disposition === "deferred"),
  );
  for (const name of [
    "assignment.json",
    "baseline.json",
    "after.json",
    "provenance.json",
    "events.jsonl",
    "session-exit.json",
    "proposal.json",
    "outcome.json",
  ]) {
    assert.ok(fs.existsSync(path.join(report.directory, name)), name);
  }
  assert.ok(
    fs
      .readdirSync(report.directory)
      .some((name) => name.endsWith(".applied.json")),
  );
  assert.ok(!fs.existsSync(path.join(report.directory, "pending.json")));
  assert.ok(!fs.existsSync(path.join(project.root, "escaped")));
  assert.ok(!fs.existsSync(path.join(project.root, "result.json")));
});
