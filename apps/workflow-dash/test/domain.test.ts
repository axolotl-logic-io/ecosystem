import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configure } from "../config.ts";
import { loadSubagentRuns } from "../subagent-runs.ts";

const unverified = /unverified/u;

test("subagent loader shows explicitly recorded accounts and leaves missing accounts unknown", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "dash-subagent-source-"));
  try {
    await mkdir(join(root, "with-account"));
    await mkdir(join(root, "without-account"));
    const status = {
      state: "complete",
      startedAt: "2000-01-01T00:00:00Z",
      task: "fixture work",
    };
    await writeFile(
      join(root, "with-account/status.json"),
      JSON.stringify({ ...status, account: "fixture-account" }),
    );
    await writeFile(
      join(root, "without-account/status.json"),
      JSON.stringify(status),
    );
    const config = configure({ subagentRuns: root });
    assert.deepEqual(await loadSubagentRuns(config), []);
    const runs = await loadSubagentRuns(config, true);
    assert.equal(runs.length, 2);
    assert.equal(
      runs.find((run) => run.id === "with-account")?.account,
      "fixture-account",
    );
    assert.equal(
      runs.find((run) => run.id === "without-account")?.account,
      null,
    );
    assert.match(runs[0].accountSource, unverified);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
