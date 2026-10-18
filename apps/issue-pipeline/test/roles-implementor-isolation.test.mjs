// @ts-check
// The implementor role's layout and isolation (#414): its modules under
// src/roles/implementor/ import nothing from the triage, spec writer or
// reviewer roles; each entry's states have their own module beside
// machine.ts; and the registry runs the role for each stage in its one
// list, `implement` and `fix` (#418), leaving open-pr and the later
// stages to the sweep.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { IMPLEMENTOR_STAGES } from "../src/roles/implementor/implementor.ts";
import { roleOf } from "../src/roles/registry.ts";

const ROLE_DIR = path.join(import.meta.dirname, "..", "src", "roles");
const IMPLEMENTOR_DIR = path.join(ROLE_DIR, "implementor");
const OTHER_ROLES = ["triage", "spec-writer", "reviewer"];
const IMPORT_FROM = /(?:from|import)\s*\(?\s*"(?<spec>[^"]+)"/gu;

/** @param {string} dir @returns {string[]} every .ts file under `dir` */
function sourcesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** @param {string} file @returns {string[]} its imports of another role's modules */
function otherRoleImports(file) {
  const found = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_FROM)) {
    const { spec = "" } = match.groups ?? {};
    const target = path.resolve(path.dirname(file), spec);
    const [top = ""] = path.relative(ROLE_DIR, target).split(path.sep);
    if (OTHER_ROLES.includes(top)) {
      found.push(`${path.relative(ROLE_DIR, file)} imports ${spec}`);
    }
  }
  return found;
}

test("the implementor's modules import nothing from the triage, spec writer or reviewer roles", () => {
  const files = sourcesUnder(IMPLEMENTOR_DIR);
  const names = files.map((file) => path.basename(file));
  for (const module of ["machine.ts", "start.ts", "implement.ts", "fix.ts"]) {
    assert.ok(names.includes(module), `scans ${module}`);
  }
  assert.deepEqual(files.flatMap(otherRoleImports), []);
});

test("each entry's states have their own module, which machine.ts joins", () => {
  const files = readdirSync(IMPLEMENTOR_DIR);
  for (const file of [
    "machine.ts",
    "start.ts",
    "implement.ts",
    "fix.ts",
    "sync.ts",
  ]) {
    assert.ok(files.includes(file), `src/roles/implementor/${file}`);
  }
  const machine = readFileSync(
    path.join(IMPLEMENTOR_DIR, "machine.ts"),
    "utf8",
  );
  for (const entry of [
    "./start.ts",
    "./implement.ts",
    "./fix.ts",
    "./sync.ts",
  ]) {
    assert.ok(machine.includes(`"${entry}"`), `machine.ts imports ${entry}`);
  }
});

test("the registry runs the implementor for each stage in its list: implement, fix and sync (#419), and not open-pr", () => {
  assert.deepEqual(IMPLEMENTOR_STAGES, ["implement", "fix", "sync"]);
  for (const stage of IMPLEMENTOR_STAGES) {
    const role = roleOf(stage);
    assert.equal(role?.name, "implementor", stage);
    assert.equal(role?.kind, "machine", stage);
  }
  for (const stage of ["open-pr", "checks"]) {
    assert.equal(roleOf(stage), undefined, stage);
  }
});
