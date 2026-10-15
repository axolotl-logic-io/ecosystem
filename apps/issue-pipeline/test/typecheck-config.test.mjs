// @ts-check
// npm run typecheck type-checks a file under test/ that opts in with
// `// @ts-check`: a fixture with a type error fails with that error, and the
// same fixture without it passes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const APP_DIR = new URL("..", import.meta.url).pathname;
// The fixture sits in its own folder under test/, where tsconfig.test.json's
// `test/**/*.mjs` takes it in.
const FIXTURES_DIR = path.join(APP_DIR, "test");
const ARGUMENT_TYPE_ERROR = /fixture\.mjs\(\d+,\d+\): error TS2345:/u;

/**
 * Returns a checked fixture that passes `argument` to a function whose JSDoc
 * takes a number.
 * @param {string} argument
 * @returns {string}
 */
function fixture(argument) {
  return [
    "// @ts-check",
    "/**",
    " * @param {number} n",
    " * @returns {number}",
    " */",
    "function twice(n) {",
    "  return n * 2;",
    "}",
    `twice(${argument});`,
    "",
  ].join("\n");
}

/**
 * Runs `npm run typecheck` with one fixture under test/, then removes it.
 * @param {string} source
 * @returns {{ status: number | null, output: string }}
 */
function typecheck(source) {
  const dir = fs.mkdtempSync(path.join(FIXTURES_DIR, "typecheck-fixture-"));
  try {
    fs.writeFileSync(path.join(dir, "fixture.mjs"), source);
    const r = spawnSync("npm", ["run", "typecheck"], {
      cwd: APP_DIR,
      encoding: "utf8",
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("typecheck fails on a type error in a @ts-check test file", () => {
  const { status, output } = typecheck(fixture('"one"'));
  assert.notEqual(status, 0, output);
  assert.match(output, ARGUMENT_TYPE_ERROR);
});

test("typecheck passes the same @ts-check test file without the error", () => {
  const { status, output } = typecheck(fixture("1"));
  assert.equal(status, 0, output);
});
