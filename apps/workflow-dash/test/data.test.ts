import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { configure, defaults } from "../config.ts";
import { readCap, safePath } from "../local-files.ts";
import { jsonl, parse, workflowSchema } from "../source-records.ts";
import { loadWorkflowRuns, workflowRunDetails } from "../workflow-source.ts";
import { materializeFixtures } from "./fixture-test-kit.ts";
import { makeRun } from "./model-fixtures.ts";

const fixtureRoot: string = await materializeFixtures(
  new URL("./fixtures/", import.meta.url),
);
after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});
const fixtures = join(fixtureRoot, "runs", "axolotl-logic-io__project-buddy");
const issues = { partial: 999, noJournal: 299 };
const expectedCurrentRuns = 3;
const byteLimits = { small: 80, full: 1_048_576 };
const testsSummary = /ℹ tests 4/u;
const cancellationsSummary = /ℹ cancelled 0/u;

test("real fixture loader ignores a partial job and tolerates missing journals", async () => {
  const runs = await loadWorkflowRuns(
    {
      ...defaults,
      runs: join(fixtureRoot, "runs"),
      repos: ["axolotl-logic-io/project-buddy"],
    },
    () => Promise.resolve(false),
  );
  assert.equal(
    runs.filter((run) => run.data.history !== true).length,
    expectedCurrentRuns,
  );
  assert.equal(
    runs.some((run) => run.issue === issues.partial),
    false,
  );
  assert.equal(
    runs.every((run) => run.live === false),
    true,
  );
  assert.equal(
    runs.find((run) => run.issue === issues.noJournal)?.records.length,
    0,
  );
});
test("partial JSON and corrupt JSONL are ignored; bounded reads", async () => {
  assert.equal(parse('{"x":'), null);
  assert.deepEqual(jsonl('{"a":1}\nbad\n{"b":2}\n{"c":'), [{ a: 1 }, { b: 2 }]);
  const text = await readCap(
    join(fixtures, "issue-494/job.json"),
    byteLimits.small,
  );
  assert.ok(Buffer.byteLength(text) <= byteLimits.small);
  const full = workflowSchema.parse(
    parse(await readCap(join(fixtures, "issue-494/job.json"), byteLimits.full)),
  );
  assert.ok(full.launches.length > 0);
  assert.ok(
    jsonl(await readCap(join(fixtures, "issue-494/jobs.jsonl"))).length > 0,
  );
  assert.equal(await readCap("/nonexistent/workflow-dash"), "");
});
test("run drill-down reads bounded verification summaries and local stop reasons", async () => {
  const details = await workflowRunDetails(
    makeRun(
      { outcome: { kind: "finished" } },
      {
        dir: join(fixtures, "issue-494"),
        records: [{ kind: "job", reason: "review timeout" }],
      },
    ),
  );
  assert.equal(details.stopReason, "review timeout");
  assert.match(details.verify.join("\n"), testsSummary);
  assert.match(details.verify.join("\n"), cancellationsSummary);
  assert.equal(details.verify.join("\n").includes("verbose line"), false);
});
test("configuration expands home and rejects bad repo names; credentials denied", async () => {
  assert.ok(configure({ runs: "~/fixtures" }).runs.endsWith("/fixtures"));
  assert.deepEqual(configure({ repos: ["../bad"] }).repos, defaults.repos);
  await assert.rejects(safePath("/tmp/.env-secret"));
  await assert.rejects(safePath("/tmp/runtime/home/auth.json"));
  await assert.rejects(safePath("/tmp/runtime/model-key.env"));
});
