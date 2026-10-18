// @ts-check
// The orchestrator runs only the chosen roles (#417): one table gives each
// stage's pipeline role, and the roles come from --roles, else the config's
// orchestratorRoles, else all five; an unknown or empty role name is refused,
// naming it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { orchestratorArgsOf } from "../src/orchestrator/args.ts";
import { roleOfStage, rolesOf } from "../src/orchestrator/roles.ts";
import { ROLE_NAMES } from "../src/roles/registry.ts";
import { STAGE_ORDER } from "../src/workflow/sweep-config.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-roles-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let files = 0;

// The wiki's stage-to-role table (Pipeline-Roles-Orchestrator, "Run only the
// chosen roles").
const ROLE_OF = {
  triage: "triage",
  spec: "spec-writer",
  implement: "implementor",
  "open-pr": "implementor",
  fix: "implementor",
  sync: "implementor",
  checks: "implementor",
  review: "reviewer",
  accept: "reviewer",
  security: "reviewer",
  merge: "finalizer",
  publish: "finalizer",
};
const UNKNOWN_ROLE = /nope/u;
const EMPTY_NAME = /empty/u;
const ROLES_FLAG = /--roles/u;
const ROLES_KEY = /orchestratorRoles/u;

// A loaded config with `extra` over the minimal keys.
/** @param {object} extra @returns {import("../src/config.ts").Config} */
function configWith(extra) {
  files += 1;
  const file = path.join(tmp, `config-${files}.json`);
  const base = {
    repo: "o/r",
    account: "a",
    allowedUsers: ["a"],
    commands: { test: "true" },
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
  return loadConfig(file);
}

test("every stage in STAGE_ORDER has the role the wiki's table gives it", () => {
  assert.deepEqual(
    Object.fromEntries(STAGE_ORDER.map((stage) => [stage, roleOfStage(stage)])),
    ROLE_OF,
  );
});

test("every role owns at least one stage, and no stage names another role", () => {
  const owners = new Set(STAGE_ORDER.map(roleOfStage));
  assert.deepEqual(
    ROLE_NAMES.filter((role) => !owners.has(role)),
    [],
  );
  assert.ok([...owners].every((role) => ROLE_NAMES.includes(role)));
});

test("with no flag and no orchestratorRoles, all five roles run", () => {
  assert.deepEqual(rolesOf({}, configWith({})), [...ROLE_NAMES]);
  assert.deepEqual(rolesOf({}, configWith({ orchestratorRoles: null })), [
    ...ROLE_NAMES,
  ]);
});

test("orchestratorRoles picks the roles, in ROLE_NAMES order", () => {
  const cfg = configWith({ orchestratorRoles: ["reviewer", "triage"] });
  assert.deepEqual(rolesOf({}, cfg), ["triage", "reviewer"]);
});

test("--roles overrides orchestratorRoles", () => {
  const cfg = configWith({ orchestratorRoles: ["reviewer"] });
  assert.deepEqual(rolesOf({ roles: ["spec-writer", "triage"] }, cfg), [
    "triage",
    "spec-writer",
  ]);
});

test("an unknown role name from --roles is refused, naming it", () => {
  assert.throws(
    () => rolesOf({ roles: ["triage", "nope"] }, configWith({})),
    UNKNOWN_ROLE,
  );
});

test("an unknown or empty role name, or no role, in orchestratorRoles is refused, naming the key", () => {
  for (const orchestratorRoles of [["triage", "nope"], ["triage", ""], []]) {
    assert.throws(
      () => rolesOf({}, configWith({ orchestratorRoles })),
      ROLES_KEY,
      JSON.stringify(orchestratorRoles),
    );
  }
  assert.throws(
    () => rolesOf({}, configWith({ orchestratorRoles: ["nope"] })),
    UNKNOWN_ROLE,
  );
});

test("--roles is split on commas, and --print-roles is read", () => {
  const args = orchestratorArgsOf([
    "--config",
    "c.json",
    "--roles",
    "triage,spec-writer",
    "--print-roles",
  ]);
  assert.deepEqual(args.roles, ["triage", "spec-writer"]);
  assert.equal(args.printRoles, true);
  assert.equal(orchestratorArgsOf(["--config", "c.json"]).roles, undefined);
});

test("an empty role name in --roles is refused, naming the flag", () => {
  for (const value of ["triage,,reviewer", "", "triage,"]) {
    assert.throws(
      () => orchestratorArgsOf(["--config", "c.json", "--roles", value]),
      (error) =>
        error instanceof Error &&
        ROLES_FLAG.test(error.message) &&
        EMPTY_NAME.test(error.message),
      value,
    );
  }
});
