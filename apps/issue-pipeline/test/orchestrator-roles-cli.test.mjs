// @ts-check
// The orchestrator's command line with roles (#417), run from src with a fake
// gh: --print-roles prints the stage-to-role table and the roles chosen, then
// exits 0 without a tick; an unknown or empty role name, from --roles or the
// config's orchestratorRoles, exits 1 naming it; and a run logs the roles it
// chose once, as an `action: "roles"` line, before its tick's decisions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import {
  configWith,
  fakeGh,
  openWith,
  runFile,
} from "./orchestrator-world-test-kit.mjs";

const { STAGE_ORDER } = await import("../src/workflow/sweep-config.ts");
const { roleOfStage } = await import("../src/orchestrator/roles.ts");

const ORCHESTRATE = new URL("../src/orchestrate.ts", import.meta.url).pathname;
// The bound on one orchestrator run. A run here makes no gh call or one read
// of a one-issue queue, which took under 1 s unloaded; the bound sits below
// the suite's --test-timeout (mise.toml), so a hung run fails by its title.
const RUN_BOUND_MS = 60_000;
const REVIEWING = 90;
const PR_OF_REVIEWING = 9;
const UNKNOWN_ROLE = /nope/u;
const ROLES_FLAG = /--roles/u;
const ROLES_KEY = /orchestratorRoles/u;
const EMPTY_NAME = /empty/u;
const LINE = z.looseObject({ action: z.string() });
const ROLES_LINE = z.strictObject({
  at: z.string(),
  action: z.literal("roles"),
  roles: z.array(z.string()),
});
const HELD_LINE = z.looseObject({
  issue: z.number(),
  action: z.literal("held"),
  reason: z.string(),
});

/** @param {string[]} args @returns {import("node:child_process").SpawnSyncReturns<string>} */
function orchestrate(args) {
  return spawnSync(process.execPath, [ORCHESTRATE, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: RUN_BOUND_MS,
  });
}

// The lines orchestrator.log holds, parsed.
/** @returns {z.infer<typeof LINE>[]} */
function logLines() {
  const file = runFile("orchestrator.log");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LINE.parse(JSON.parse(line)));
}

test("--print-roles prints each stage's role and the roles chosen, and exits 0 without a tick", () => {
  const config = configWith({ orchestratorRoles: ["reviewer", "triage"] });
  fakeGh.reply([]);
  const before = logLines().length;
  const printed = orchestrate(["--config", config, "--print-roles"]);
  assert.equal(printed.status, 0, printed.stderr);
  const lines = printed.stdout.split("\n");
  for (const stage of STAGE_ORDER) {
    assert.ok(lines.includes(`${stage}\t${roleOfStage(stage)}`), stage);
  }
  assert.ok(lines.includes("roles: triage,reviewer"), printed.stdout);
  const flagged = orchestrate([
    "--config",
    config,
    "--roles",
    "spec-writer",
    "--print-roles",
  ]);
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.ok(flagged.stdout.split("\n").includes("roles: spec-writer"));
  assert.deepEqual(fakeGh.calls(), []);
  assert.equal(logLines().length, before);
});

test("an unknown role name exits 1 naming it, from --roles or orchestratorRoles, before any tick", () => {
  fakeGh.reply([]);
  const flagged = orchestrate([
    "--config",
    configWith({}),
    "--roles",
    "triage,nope",
    "--once",
  ]);
  assert.equal(flagged.status, 1);
  assert.match(flagged.stderr, UNKNOWN_ROLE);
  const configured = orchestrate([
    "--config",
    configWith({ orchestratorRoles: ["nope"] }),
    "--once",
  ]);
  assert.equal(configured.status, 1);
  assert.match(configured.stderr, UNKNOWN_ROLE);
  assert.match(configured.stderr, ROLES_KEY);
  assert.deepEqual(fakeGh.calls(), []);
});

test("an empty role name in --roles exits 1 naming the flag", () => {
  fakeGh.reply([]);
  const empty = orchestrate([
    "--config",
    configWith({}),
    "--roles",
    "triage,,reviewer",
    "--once",
  ]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, ROLES_FLAG);
  assert.match(empty.stderr, EMPTY_NAME);
  assert.deepEqual(fakeGh.calls(), []);
});

test("a run logs the roles chosen once, the flag's over the config's, then holds an issue of a role that is off", () => {
  const config = configWith({ orchestratorRoles: ["reviewer"] });
  openWith([
    { number: REVIEWING, state: { stage: "review", pr: PR_OF_REVIEWING } },
  ]);
  const before = logLines().length;
  const run = orchestrate(["--config", config, "--roles", "triage", "--once"]);
  assert.equal(run.status, 0, run.stderr);
  const [first, ...rest] = logLines().slice(before);
  assert.deepEqual(ROLES_LINE.parse(first).roles, ["triage"]);
  assert.deepEqual(
    rest.filter(({ action }) => action === "roles"),
    [],
  );
  const held = rest.map((line) => HELD_LINE.parse(line));
  assert.deepEqual(
    held.map(({ issue, reason }) => `#${issue} ${reason}`),
    [`#${REVIEWING} role-off:reviewer`],
  );
});
