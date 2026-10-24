// @ts-check
// The typecheck `npm run check` runs covers every test
// file, with or without a `// @ts-check` line (README, #223). Both gates give
// each selected test a timeout (#372). Fixtures go in a temporary folder,
// never under test/.
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
const ARGUMENT_TYPE_ERROR = /fixture\.mjs\(\d+,\d+\): error TS2345:/u;
// The fast and full gates: scripts in package.json, which mise.toml's check
// tasks call.
const CHECK_SCRIPTS = ["check", "check:full"];
// The step of a check script that runs node --test, up to the next step.
const NODE_TEST_STEP = /(?:^|&& )node --test (?<flags>.*?)(?: &&|$)/u;
const TEST_TIMEOUT = /(?:^| )--test-timeout=(?<ms>\d+)(?: |$)/u;

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

test("both check scripts give each Node test a timeout", () => {
  const manifest = fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8");
  /** @type {{ scripts?: Record<string, string> }} */
  const { scripts = {} } = JSON.parse(manifest);
  for (const name of CHECK_SCRIPTS) {
    const script = scripts[name] ?? "";
    assert.notEqual(script, "", `package.json has a ${name} script`);
    const { flags = "" } = NODE_TEST_STEP.exec(script)?.groups ?? {};
    assert.notEqual(flags, "", `the ${name} script runs node --test`);
    const { ms = "0" } = TEST_TIMEOUT.exec(flags)?.groups ?? {};
    assert.ok(Number(ms) > 0, `node --test ${flags} has no --test-timeout`);
  }
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
      timeout: 60_000,
    });
    const output = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, output);
    assert.match(output, ARGUMENT_TYPE_ERROR);
    fs.writeFileSync(
      path.join(dir, "fixture.mjs"),
      source.replace('twice("one")', "twice(1)"),
    );
    const clean = spawnSync(process.execPath, [tsc, "-p", configFile], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);
  });
});
