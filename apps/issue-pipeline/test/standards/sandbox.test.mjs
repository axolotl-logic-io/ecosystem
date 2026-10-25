// @ts-check
// `standards-upgrade assess` running install, tests and the advisory scan in
// its bwrap sandbox (#129), against a fake npm registry in its own process.
// A clean repository is rated acceptable, a reported advisory or a failing
// test isn't, and repository code finds no credential, no host file, no
// other process and no network, while what it prints never reaches the
// assessment, report or plan.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assess, statusOf } from "./standards-test-kit.mjs";

const REGISTRY = path.join(import.meta.dirname, "fake-npm-registry.mjs");
const PROBE = path.join(import.meta.dirname, "sandbox-probe.cjs");
const POLL_MS = 50;
// npm audit's bulk answer, in npm's wire format: one high advisory against
// leftish.
const ADVISORY = [
  '{"leftish":[{"id":1,"url":"https://example.invalid/advisory/1",',
  '"title":"Padding overflow","severity":"high","vulnerable_versions":"<2.0.0",',
  '"cwe":[],"cvss":{"score":7.5,"vectorString":null}}]}',
].join("");
const READY_MS = 10_000;
const CANARY = "canary-7f3c9e1d-credential";
const PRINTED = "PRINTED-BY-REPOSITORY-CODE";
const HIGH = /1 high/u;
const EXITED_1 = /npm test exited 1/u;
const NO_EFFECTS = { writes: [], originMoved: false };
const WORKFLOW = [
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm ci",
  "      - run: npm test",
  "",
].join("\n");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-sandbox-"));
/** @type {import("node:child_process").ChildProcess | undefined} */
let registry;
let url = "";

before(async () => {
  const tarballs = path.join(work, "tarballs");
  const pkg = path.join(work, "pkg", "package");
  fs.mkdirSync(tarballs, { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "leftish", version: "1.0.0", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(pkg, "index.js"),
    "module.exports = (text, width) => text.padStart(width);\n",
  );
  spawnSync("tar", [
    "-czf",
    path.join(tarballs, "leftish-1.0.0.tgz"),
    "-C",
    path.dirname(pkg),
    "package",
  ]);
  registry = spawn(process.execPath, [REGISTRY, work], { stdio: "ignore" });
  const portFile = path.join(work, "port");
  await untilExists(portFile, performance.now() + READY_MS);
  url = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8")}/`;
});
after(() => {
  registry?.kill();
  fs.rmSync(work, { recursive: true, force: true });
});

/**
 * Resolves once `file` exists, or rejects past `deadline`.
 * @param {string} file @param {number} deadline
 * @returns {Promise<void>}
 */
async function untilExists(file, deadline) {
  if (fs.existsSync(file)) {
    return;
  }
  if (performance.now() >= deadline) {
    throw new Error(`the fake registry never wrote ${file}`);
  }
  await delay(POLL_MS);
  await untilExists(file, deadline);
}

/** @param {string} advisories the JSON the registry's audit answers */
function advise(advisories) {
  fs.writeFileSync(path.join(work, "advisories.json"), advisories);
}

/** @returns {{ method: string, url: string }[]} */
function hits() {
  const file = path.join(work, "hits.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  return lines.filter((line) => line !== "").map((line) => JSON.parse(line));
}

function clearHits() {
  fs.rmSync(path.join(work, "hits.jsonl"), { force: true });
}

/**
 * A Node app depending on leftish from the fake registry, whose tests are
 * `files` run by its `test` script.
 * @param {Record<string, string>} files @param {string} script
 */
function appWith(files, script) {
  const tarball = fs.readFileSync(
    path.join(work, "tarballs", "leftish-1.0.0.tgz"),
  );
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const manifest = {
    name: "app",
    version: "1.0.0",
    private: true,
    engines: { node: ">=24" },
    scripts: { test: script },
    dependencies: { leftish: "1.0.0" },
  };
  const lock = {
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { ...manifest, scripts: undefined, private: undefined },
      "node_modules/leftish": {
        version: "1.0.0",
        resolved: `${url}leftish/-/leftish-1.0.0.tgz`,
        integrity,
      },
    },
  };
  return {
    branches: {
      main: {
        "package.json": JSON.stringify(manifest),
        "package-lock.json": JSON.stringify(lock),
        ".github/dependabot.yml": "version: 2\n",
        ".github/workflows/ci.yml": WORKFLOW,
        ...files,
      },
    },
  };
}

// Passes on its first run and fails on every later one: it leaves a mark in
// the work folder, which outlives one sandboxed command.
const FLAKY = [
  "const fs = require('node:fs');",
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "test('flips', () => {",
  "  const seen = fs.existsSync('.ran');",
  "  fs.writeFileSync('.ran', '');",
  "  assert.equal(seen, false);",
  "});",
  "",
].join("\n");
const FLAKY_EVIDENCE = /flaky: it exited 0, then 1/u;
const FALSE_SUCCESS =
  /exited 0 again with a deliberately failing test added at test\/standards-mismatch\.test\.js/u;

const PASSING = {
  "test/pad.test.js": [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const pad = require('leftish');",
    "test('pads', () => assert.equal(pad('a', 3), '  a'));",
    "",
  ].join("\n"),
};

/** @param {ReturnType<typeof assess>} run */
function effectsOf(run) {
  return { writes: run.writes, originMoved: run.originMoved };
}

/** @param {ReturnType<typeof assess>} run @param {string} id */
function evidenceOf(run, id) {
  const found = run
    .assessment()
    .criteria.find((criterion) => criterion.id === id);
  return found?.evidence ?? "";
}

/**
 * @param {Record<string, string>} files @param {Record<string, string>} [env]
 * @param {string} [script] the app's test script
 */
function assessApp(files, env = {}, script = "node --test") {
  return assess(appWith(files, script), {
    view: { protection: ["test"], rules: [] },
    args: ["--npm-registry", url],
    env,
  });
}

describe("standards-upgrade assess in the sandbox", () => {
  test("rates a clean repository acceptable once install, tests and the scan pass", () => {
    advise("{}");
    clearHits();
    const run = assessApp(PASSING);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(effectsOf(run), NO_EFFECTS);
    const assessment = run.assessment();
    assert.equal(
      assessment.verdict,
      "acceptable",
      JSON.stringify(assessment.criteria),
    );
    for (const id of [
      "environment.install",
      "vulnerabilities.scan",
      "behavior.tests-run",
    ]) {
      assert.equal(statusOf(assessment, id), "passed", id);
    }
    assert.deepEqual(
      assessment.commands.map(({ argv, network, exitCode }) => [
        argv.join(" "),
        network,
        exitCode,
      ]),
      [
        ["npm ci --ignore-scripts --no-audit", true, 0],
        ["npm audit --json", true, 0],
        ["npm rebuild --foreground-scripts", false, 0],
        ["npm test", false, 0],
        ["npm test", false, 0],
        ["write-test test/standards-mismatch.test.js", false, 0],
        ["npm test", false, 1],
      ],
    );
    assert.equal(assessment.sandbox?.registry, url);
    assert.deepEqual(run.written, ["assessment.json", "logs", "report.md"]);
    assert.deepEqual(fs.readdirSync(path.join(run.out, "logs")).sort(), [
      "1-npm-ci.log",
      "2-npm-audit.log",
      "3-npm-rebuild.log",
      "4-npm-test.log",
      "5-npm-test.log",
      "6-write-mismatch.log",
      "7-npm-test.log",
    ]);
    assert.deepEqual(
      hits().map((hit) => `${hit.method} ${hit.url}`),
      [
        "GET /leftish/-/leftish-1.0.0.tgz",
        "POST /-/npm/v1/security/advisories/bulk",
      ],
    );
  });

  test("fails the scan on a reported advisory and the tests on a failing one", () => {
    advise(ADVISORY);
    const vulnerable = assessApp(PASSING);
    assert.equal(
      statusOf(vulnerable.assessment(), "vulnerabilities.scan"),
      "failed",
    );
    assert.match(evidenceOf(vulnerable, "vulnerabilities.scan"), HIGH);
    assert.equal(vulnerable.assessment().verdict, "not-acceptable");

    advise("{}");
    const failing = assessApp({
      "test/pad.test.js": [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "test('pads', () => assert.equal(1, 2));",
        "",
      ].join("\n"),
    });
    assert.equal(
      statusOf(failing.assessment(), "behavior.tests-run"),
      "failed",
    );
    assert.match(evidenceOf(failing, "behavior.tests-run"), EXITED_1);
    assert.equal(failing.assessment().verdict, "not-acceptable");
  });

  test("fails a flaky suite and a runner that exits 0 with a failing test", () => {
    advise("{}");
    const flaky = assessApp({ "test/flip.test.js": FLAKY });
    assert.equal(statusOf(flaky.assessment(), "behavior.tests-run"), "failed");
    assert.match(evidenceOf(flaky, "behavior.tests-run"), FLAKY_EVIDENCE);
    const hiding = assessApp(PASSING, {}, "node --test || true");
    assert.equal(statusOf(hiding.assessment(), "behavior.tests-run"), "failed");
    assert.match(evidenceOf(hiding, "behavior.tests-run"), FALSE_SUCCESS);
    for (const run of [flaky, hiding]) {
      assert.equal(run.assessment().verdict, "not-acceptable");
    }
  });

  test("writes the failing test inside the sandbox, so a planted symlink can't reach the host", () => {
    advise("{}");
    const target = path.join(work, "escaped.js");
    const planting = [
      "const fs = require('node:fs');",
      "const test = require('node:test');",
      // On the second run, after its files are found, so both runs pass.
      "test('plants a symlink where the failing test goes', () => {",
      "  if (!fs.existsSync('.ran')) { fs.writeFileSync('.ran', ''); return; }",
      "  try {",
      `    fs.symlinkSync(${JSON.stringify(target)}, 'test/standards-mismatch.test.js');`,
      "  } catch {}",
      "});",
      "",
    ].join("\n");
    const run = assessApp({ "test/plant.test.js": planting });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(
      run
        .assessment()
        .commands.slice(-2)
        .map(({ argv, exitCode }) => [argv[0], exitCode]),
      [
        ["npm", 0],
        ["write-test", 1],
      ],
    );
    assert.equal(
      statusOf(run.assessment(), "behavior.tests-run"),
      "unverified",
    );
  });

  test("gives repository code no credential, host file, process or network, and keeps its output out of the results", () => {
    advise("{}");
    clearHits();
    const home = fs.mkdtempSync(path.join(work, "home-"));
    fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".npmrc"),
      `//registry.npmjs.org/:_authToken=${CANARY}\n`,
    );
    fs.writeFileSync(
      path.join(home, ".config", "gh", "hosts.yml"),
      `oauth_token: ${CANARY}\n`,
    );
    const hostFile = path.join(work, "host-secret.txt");
    fs.writeFileSync(hostFile, `${CANARY}\n`);
    // The probe the repository's test runs, and what it looks for.
    const probe = {
      "test/probe.test.js": fs.readFileSync(PROBE, "utf8"),
      "test/probe.json": JSON.stringify({
        printed: PRINTED,
        canaries: [
          CANARY,
          "fake-pipeline-dev--dev-bot",
          "fake-pipeline-merge--lawd",
        ],
        files: [
          hostFile,
          path.join(home, ".npmrc"),
          path.join(home, ".config", "gh", "hosts.yml"),
        ],
        dirs: [home, work, os.tmpdir()],
        port: Number(new URL(url).port),
      }),
    };
    const run = assessApp(
      probe,
      Object.fromEntries([
        ["HOME", home],
        ["GH_TOKEN", CANARY],
        ["STANDARDS_CANARY_TOKEN", CANARY],
      ]),
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      statusOf(run.assessment(), "behavior.tests-run"),
      "passed",
      fs.readFileSync(path.join(run.out, "logs", "4-npm-test.log"), "utf8"),
    );
    assert.equal(
      hits().some((hit) => hit.url === "/probe"),
      false,
    );
    const results = ["assessment.json", "report.md"]
      .map((name) => run.text(name))
      .join("\n");
    assert.equal(results.includes(PRINTED), false);
    assert.equal(results.includes(CANARY), false);
    const logs = fs.readFileSync(
      path.join(run.out, "logs", "4-npm-test.log"),
      "utf8",
    );
    assert.equal(logs.includes(PRINTED), true);
    assert.equal(logs.includes(CANARY), false);
  });
});
