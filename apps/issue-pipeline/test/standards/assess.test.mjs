// @ts-check
// `standards-upgrade assess` (#129) run as its own process against a fake
// GitHub and local bare origins holding fixture repositories. Every case
// also checks that the assessment wrote nothing to GitHub or the origin.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { assess, statusOf } from "./standards-test-kit.mjs";

// A file the gappy fixture's npm `prepare` script would create if any
// repository code ran.
const SENTINEL = path.join(os.tmpdir(), `standards-prepare-ran-${process.pid}`);

const REQUIRE_CHECK = /Require the CI check on main/u;
const PLAN_MARKER = /<!-- standards-upgrade:plan (?<json>\{.*\}) -->/u;
const EVIDENCED_FAILURE = /evidenced failure/u;
const BRANCH_PROTECTION = /branch protection/u;
const OPERATOR_AUTHORITY = /explicit operator authority/u;
const PYTHON = /python/u;
const NOT_CONFIGURED = /isn't the configured repository o\/r/u;
const RENAMED = /GitHub names o\/r o\/renamed/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const NO_COMMIT = /names no commit/u;
// What an assessment may change: nothing on GitHub or the origin.
const NO_EFFECTS = { writes: [], originMoved: false };

const GAPPY = {
  branches: {
    main: {
      "package.json": JSON.stringify({
        name: "app",
        private: true,
        workspaces: ["packages/*"],
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
          prepare: `node -e "require('fs').writeFileSync('${SENTINEL}', 'ran')"`,
        },
      }),
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
      }),
      "src/index.js": "export const answer = 42;\n",
      ".husky/pre-commit": `#!/bin/sh\ntouch ${SENTINEL}\n`,
      ".github/workflows/ci.yml": [
        "on:",
        "  push:",
        "    branches: [main]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm test || true",
        "",
      ].join("\n"),
    },
  },
};

const HEALTHY = {
  branches: {
    main: {
      "package.json": JSON.stringify({
        name: "app",
        private: true,
        engines: { node: ">=24" },
        scripts: { test: "node --test" },
      }),
      "package-lock.json": "{}\n",
      "test/answer.test.js": "import test from 'node:test';\n",
      ".github/dependabot.yml": "version: 2\n",
      ".github/workflows/ci.yml": [
        "on: [push, pull_request]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm ci",
        "      - run: npm test",
        "",
      ].join("\n"),
    },
  },
};

const SCAFFOLD = {
  branches: {
    main: {
      "LICENSE.md": "MIT\n",
      "README.md": "# app\n",
      ".gitignore": "node_modules\n",
    },
  },
};

/** @param {ReturnType<typeof assess>} run */
function effectsOf(run) {
  return { writes: run.writes, originMoved: run.originMoved };
}

describe("standards-upgrade assess", () => {
  test("finds a Node app's gaps from source alone, runs none of its code and plans the upgrade", () => {
    const run = assess(GAPPY);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(effectsOf(run), NO_EFFECTS);
    assert.equal(fs.existsSync(SENTINEL), false);
    const assessment = run.assessment();
    assert.equal(assessment.disposition.kind, "node-npm");
    assert.equal(assessment.verdict, "not-acceptable");
    assert.deepEqual(
      Object.fromEntries(
        assessment.criteria.map(({ id, status }) => [id, status]),
      ),
      {
        "environment.manifest": "passed",
        "environment.toolchain": "failed",
        "environment.lockfile": "failed",
        "behavior.tests": "failed",
        "environment.install": "unverified",
        "vulnerabilities.scan": "unverified",
        "behavior.tests-run": "unverified",
        "ci.triggers": "failed",
        "ci.runs-tests": "passed",
        "ci.failure-propagation": "failed",
        "ci.advisory-refresh": "failed",
        "ci.workspaces": "failed",
        "enforcement.required-checks": "failed",
      },
    );
    assert.deepEqual(
      assessment.inventory.components.map((component) => component.path),
      [".", "packages/lib"],
    );
    assert.deepEqual(assessment.commands, []);
    assert.match(assessment.ownerActions.join("\n"), REQUIRE_CHECK);
    assert.deepEqual(run.written, ["assessment.json", "plan.md", "report.md"]);
    const { json = "null" } =
      PLAN_MARKER.exec(run.text("plan.md"))?.groups ?? {};
    const { digest, ...binding } = JSON.parse(json);
    assert.deepEqual(binding, {
      version: 1,
      repo: "o/r",
      source: assessment.source,
      policy: "standards-v1",
    });
    assert.match(digest, DIGEST);
    assert.match(run.text("report.md"), EVIDENCED_FAILURE);
  });

  test("never calls a statically clean repository acceptable while its checks haven't run", () => {
    const run = assess(HEALTHY, { view: { protection: ["test"], rules: [] } });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(effectsOf(run), NO_EFFECTS);
    const assessment = run.assessment();
    const unrun = [
      "environment.install",
      "vulnerabilities.scan",
      "behavior.tests-run",
    ];
    const notApplicable = ["ci.workspaces"];
    for (const { id, status } of assessment.criteria) {
      let expected = "passed";
      if (unrun.includes(id)) {
        expected = "unverified";
      } else if (notApplicable.includes(id)) {
        expected = "not-applicable";
      }
      assert.equal(status, expected, id);
    }
    assert.equal(assessment.verdict, "unverified");
    assert.deepEqual(assessment.inventory.requiredChecks, ["test"]);
  });

  test("keeps enforcement unknown when GitHub refuses the branch protection read", () => {
    const run = assess(HEALTHY, { view: { protection: null, rules: [] } });
    assert.equal(run.code, 0, run.stderr);
    const assessment = run.assessment();
    assert.equal(
      statusOf(assessment, "enforcement.required-checks"),
      "unverified",
    );
    assert.equal(assessment.inventory.requiredChecks, null);
    assert.match(assessment.ownerActions.join("\n"), BRANCH_PROTECTION);
  });

  test("recommends archiving a scaffold, and leaves archived and unsupported repositories alone", () => {
    const scaffold = assess(SCAFFOLD);
    assert.equal(scaffold.assessment().verdict, "archive-candidate");
    assert.deepEqual(scaffold.written, ["assessment.json", "report.md"]);
    assert.match(
      scaffold.assessment().ownerActions.join("\n"),
      OPERATOR_AUTHORITY,
    );

    const branchWithCode = assess({
      branches: {
        main: SCAFFOLD.branches.main,
        dev: { "main.c": "int main(void) { return 0; }\n" },
      },
    });
    assert.equal(branchWithCode.assessment().disposition.kind, "unsupported");

    const archived = assess(HEALTHY, { view: { archived: true } });
    assert.equal(archived.assessment().verdict, "no-action");
    assert.deepEqual(archived.assessment().criteria, []);
    assert.deepEqual(archived.written, ["assessment.json", "report.md"]);

    const python = assess({
      branches: {
        main: { "pyproject.toml": "[tool.poetry]\n", "main.py": "print(1)\n" },
      },
    });
    assert.equal(python.assessment().verdict, "blocked");
    assert.ok(python.assessment().disposition.toolchains.includes("python"));
    assert.match(python.assessment().disposition.detail, PYTHON);
    for (const run of [scaffold, branchWithCode, archived, python]) {
      assert.deepEqual(effectsOf(run), NO_EFFECTS);
    }
  });

  test("refuses another repository before reading anything", () => {
    const run = assess(HEALTHY, { repo: "other/r" });
    assert.equal(run.code, 2);
    assert.match(run.stderr, NOT_CONFIGURED);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.written, []);
  });

  test("refuses a renamed repository and a ref that names no commit, writing nothing", () => {
    const renamed = assess(HEALTHY, { view: { fullName: "o/renamed" } });
    assert.equal(renamed.code, 2);
    assert.match(renamed.stderr, RENAMED);
    const missing = assess(HEALTHY, { ref: "nope" });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, NO_COMMIT);
    for (const run of [renamed, missing]) {
      assert.deepEqual(run.written, []);
      assert.deepEqual(effectsOf(run), NO_EFFECTS);
    }
  });

  test("takes the canonical URL and resolves an explicit tag to its commit", () => {
    const run = assess(
      {
        ...HEALTHY,
        tags: { v1: { "package.json": HEALTHY.branches.main["package.json"] } },
      },
      { repo: "https://github.com/o/r.git", ref: "v1" },
    );
    assert.equal(run.code, 0, run.stderr);
    const assessment = run.assessment();
    assert.equal(assessment.sourceRef, "refs/tags/v1");
    assert.equal(assessment.requestedRef, "v1");
    assert.equal(assessment.disposition.kind, "node-npm");
    assert.equal(assessment.inventory.files, 1);
    assert.deepEqual(effectsOf(run), NO_EFFECTS);
  });
});
