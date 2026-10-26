// Stderr is an operator interface: exercise it in a real child process so
// neither the diagnostic sink nor its deduplication is replaced by a mock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";

const TIMEOUT_MS = 30_000;
const LOG = z.object({
  at: z.iso.datetime(),
  buddyRun: z.string(),
  repo: z.string(),
  task: z.string(),
  state: z.string(),
  reason: z.string(),
});
const DIAGNOSTICS: string = new URL(
  "../../../src/runtime/observations.ts",
  import.meta.url,
).href;

test("holds log per loop, changed reason and recurrence, without repeating a steady hold", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-diagnostics-"));
  try {
    const script = `
      const { buddyDiagnostics } = await import(${JSON.stringify(DIAGNOSTICS)});
      const log = buddyDiagnostics("run");
      const where = { repo: "o/r", task: "implement" };
      const loop = { ...where, state: "held" };
      log.held(where, "first\\nline");
      log.held(where, "first\\nline");
      log.settled([loop]);
      log.held(where, "first\\nline");
      log.held(where, "changed");
      log.settled([{ ...loop, state: "idle" }]);
      log.held(where, "changed");
      log.held({ ...where, task: "author" }, "changed");
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        env: {
          ...process.env,
          ...Object.fromEntries([["ISSUE_PIPELINE_ROOT", root]]),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const logs = result.stderr
      .trim()
      .split("\n")
      .map((line) => LOG.parse(JSON.parse(line)));
    assert.deepEqual(
      logs.map(({ buddyRun, repo, task, state, reason }) => ({
        buddyRun,
        repo,
        task,
        state,
        reason,
      })),
      [
        {
          buddyRun: "run",
          repo: "o/r",
          task: "implement",
          state: "held",
          reason: "first\nline",
        },
        {
          buddyRun: "run",
          repo: "o/r",
          task: "implement",
          state: "held",
          reason: "changed",
        },
        {
          buddyRun: "run",
          repo: "o/r",
          task: "implement",
          state: "held",
          reason: "changed",
        },
        {
          buddyRun: "run",
          repo: "o/r",
          task: "author",
          state: "held",
          reason: "changed",
        },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
