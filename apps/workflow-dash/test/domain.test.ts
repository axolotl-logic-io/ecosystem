import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBuddyRuns } from "../buddy-runs.ts";
import { configure } from "../config.ts";

const unverified = /unverified/u;

test("buddy loader shows explicitly recorded accounts and leaves missing accounts unknown", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "dash-buddy-source-"));
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
    const runs = await loadBuddyRuns(configure({ buddyRuns: root }), true);
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
