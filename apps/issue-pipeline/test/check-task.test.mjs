// @ts-check
// `mise //apps/issue-pipeline:check` typechecks and lints the pipeline before
// it runs the tests, and the typecheck covers every test file, with or without
// a `// @ts-check` line (#223). Fixtures go in a temporary folder, never under
// test/. Biome can't lint a file outside its project (it stops with "path is
// expected to be under the root"), so the lint step is checked by its place in
// the task and by the script it runs, not by a run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

const APP_DIR = new URL("..", import.meta.url).pathname;
const REPO_ROOT = path.resolve(APP_DIR, "..", "..");
// The [tasks.check] section of mise.toml, up to the next section.
const CHECK_SECTION = /^\[tasks\.check\]\n(?<section>[\s\S]*?)\n\[/mu;
// The run array inside it.
const RUN_ARRAY = /^run = \[(?<entries>[^\]]*)\]/mu;
// One double-quoted entry of the run array.
const QUOTED_ENTRY = /"(?<entry>[^"]*)"/gu;
const LINT_ENTRY = "npm run lint";
const LINT_SCRIPT = "biome check --error-on-warnings";
const TYPECHECK_ENTRY = "npm run typecheck";
const TEST_PREFIX = "node --test";
const ARGUMENT_TYPE_ERROR = /fixture\.mjs\(\d+,\d+\): error TS2345:/u;

/** @returns {string[]} the commands `[tasks.check]` runs, in order */
function checkCommands() {
  const toml = fs.readFileSync(path.join(APP_DIR, "mise.toml"), "utf8");
  const { section = "" } = CHECK_SECTION.exec(toml)?.groups ?? {};
  const { entries = "" } = RUN_ARRAY.exec(section)?.groups ?? {};
  return [...entries.matchAll(QUOTED_ENTRY)].map((match) => {
    const { entry = "" } = match.groups ?? {};
    return entry;
  });
}

/**
 * Runs `body` with a fresh temporary folder, then removes the folder.
 * @param {(dir: string) => void} body
 * @returns {void}
 */
function inTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-check-"));
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("check lints before it tests", () => {
  const commands = checkCommands();
  const lintAt = commands.indexOf(LINT_ENTRY);
  const typecheckAt = commands.indexOf(TYPECHECK_ENTRY);
  const testAt = commands.findIndex((c) => c.startsWith(TEST_PREFIX));
  assert.ok(lintAt >= 0, commands.join("\n"));
  assert.ok(typecheckAt >= 0, commands.join("\n"));
  assert.ok(testAt > lintAt && testAt > typecheckAt, commands.join("\n"));
});

test("the lint script runs Biome with the repo's policy, warnings failing", () => {
  const manifest = fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8");
  const { scripts } = JSON.parse(manifest);
  assert.equal(scripts.lint, LINT_SCRIPT);
});

test("a test file without @ts-check is type-checked", () => {
  inTempDir((dir) => {
    const source = [
      "/**",
      " * @param {number} n",
      " * @returns {number}",
      " */",
      "function twice(n) {",
      "  return n * 2;",
      "}",
      'twice("one");',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "fixture.mjs"), source);
    const config = {
      extends: path.join(APP_DIR, "tsconfig.test.json"),
      compilerOptions: {
        typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
      },
      files: ["fixture.mjs"],
      include: [],
    };
    const configFile = path.join(dir, "tsconfig.json");
    fs.writeFileSync(configFile, JSON.stringify(config));
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const r = spawnSync(process.execPath, [tsc, "-p", configFile], {
      encoding: "utf8",
    });
    const output = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, output);
    assert.match(output, ARGUMENT_TYPE_ERROR);
  });
});
