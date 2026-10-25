import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configure } from "../config.ts";
import { loadSubagentRuns } from "../subagent-runs.ts";

const deprecated = /deprecated; use subagentRuns/u;
const conflicting = /names .* not .*; subagentRuns takes precedence/u;

async function subagentRoot(prefix: string, id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, id));
  await writeFile(
    join(root, id, "status.json"),
    JSON.stringify({
      state: "complete",
      startedAt: "2000-01-01T00:00:00Z",
      task: `fixture task ${id}`,
    }),
  );
  return root;
}

test("a deprecated alias still reads subagent runs, with a warning", async () => {
  const root = await subagentRoot("dash-subagent-runs-", "agent-run-id");
  try {
    const config = configure({ operators: root });
    assert.equal(config.subagentRuns, root);
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] ?? "", deprecated);
    assert.deepEqual(await loadSubagentRuns(config), []);
    const runs = await loadSubagentRuns(config, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, "agent-run-id");
    assert.equal(runs[0]?.mission, "fixture task agent-run-id");
    assert.equal(runs[0]?.state, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subagentRuns takes precedence over a conflicting alias, which is never merged", async () => {
  const canonical = await subagentRoot("dash-subagent-canonical-", "kept");
  const alias = await subagentRoot("dash-subagent-alias-", "ignored");
  try {
    const config = configure({ subagentRuns: canonical, buddyRuns: alias });
    assert.equal(config.subagentRuns, canonical);
    assert.match(config.warnings.join("\n"), conflicting);
    const runs = await loadSubagentRuns(config, true);
    assert.deepEqual(
      runs.map((run) => run.id),
      ["kept"],
    );
    assert.deepEqual(configure({ subagentRuns: canonical }).warnings, []);
  } finally {
    await rm(canonical, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  }
});
