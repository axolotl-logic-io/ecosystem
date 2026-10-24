import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBuddyRuns } from "../buddy-runs.ts";
import { configure } from "../config.ts";

test("renamed buddy loader reads the same records and keeps today-only coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-buddy-runs-"));
  try {
    await mkdir(join(root, "agent-run-id"));
    await writeFile(
      join(root, "agent-run-id", "status.json"),
      JSON.stringify({
        state: "complete",
        startedAt: "2000-01-01T00:00:00Z",
        task: "fixture task",
      }),
    );
    const config = configure({ operators: root });
    assert.deepEqual(await loadBuddyRuns(config), []);
    const runs = await loadBuddyRuns(config, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "agent-run-id");
    assert.equal(runs[0].mission, "fixture task");
    assert.equal(runs[0].state, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
