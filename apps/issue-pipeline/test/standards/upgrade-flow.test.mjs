// @ts-check
// The standards upgrade end to end (#129): the built `standards-upgrade`
// assesses a Node/npm or a Python/Poetry repository on a local origin, an
// allow-listed person files its plan as the upgrade issue, `apply` admits
// it, and the installed caller runs the real Implementation job, which
// delivers the change as one draft PR from the development account. The
// assessment and admission write nothing; the chain's existing ops do every
// write. Plans filed by the wrong person, against a moved base, or beside
// another open plan are refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { ghAccountCalls, openIssue } from "../fake-pipeline-flow-gh.mjs";
import { readWorld } from "../fake-pipeline-flow-gh-world.mjs";
import { callerJob, stopJobs } from "../pipeline-flow-run-test-kit.mjs";
import { openFlowIssue } from "../pipeline-flow-script-test-kit.mjs";
import {
  advanceTarget,
  BASE,
  bareGit,
  ISSUE,
  refIn,
  scriptPi,
  setUpFlow,
} from "../pipeline-flow-test-kit.mjs";

/** @typedef {import("../pipeline-flow-test-kit.mjs").Flow} Flow */
/**
 * One delivery: the flow, the files the fake pi's Implementation commits,
 * and its commit message and summary.
 * @typedef {object} Delivery
 * @property {() => Flow} flow
 * @property {Record<string, string>} files
 * @property {string} message
 * @property {string} summary
 */

const ENTRY_MS = 60_000;
const BRANCH = `standards-upgrade/issue-${ISSUE}`;
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
const POETRY_WORKFLOW = [
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pipx install poetry",
  "      - run: poetry install",
  "      - run: poetry run pytest",
  "",
].join("\n");
const POETRY_TOML = [
  "[tool.poetry]",
  'name = "aoc"',
  'version = "0.1.0"',
  'description = ""',
  "",
  "[tool.poetry.dependencies]",
  'python = "^3.9"',
  "",
  "[tool.poetry.dev-dependencies]",
  'pytest = "^5.2"',
  "",
  "[build-system]",
  'requires = ["poetry-core>=1.0.0"]',
  'build-backend = "poetry.core.masonry.api"',
  "",
].join("\n");
const REAL_TEST = [
  "from aoc.day1 import solve",
  "",
  "",
  "def test_counts_lines():",
  '    assert solve(["1", "2"]) == 2',
  "",
].join("\n");
const NOT_ALLOWED = /isn't an allow-listed collaborator/u;
const MOVED = /reassess and file a new plan/u;
const ANOTHER_PLAN = /already carries an open upgrade plan/u;
const POETRY_CHECKS = /poetry run pytest and pip-audit/u;
const NPM_CHECKS = /npm ci, npm test and npm audit/u;

/** @type {Flow} */
let flow;
/** @type {Flow} */
let poetryFlow;

before(() => {
  flow = setUpFlow();
  advanceTarget(flow, {
    "package.json": `${JSON.stringify({
      name: "greeter",
      private: true,
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    })}\n`,
  });
  // Shaped like the org's aoc2021: `poetry new`'s placeholder test, no
  // lockfile and no CI.
  poetryFlow = setUpFlow();
  advanceTarget(poetryFlow, {
    "pyproject.toml": POETRY_TOML,
    "aoc/__init__.py": "__version__ = '0.1.0'\n",
    "aoc/day1.py": "def solve(lines):\n    return len(lines)\n",
    "tests/__init__.py": "",
    "tests/test_aoc.py":
      "from aoc import __version__\n\n\ndef test_version():\n    assert __version__ == '0.1.0'\n",
  });
});
after(() => {
  stopJobs(flow);
  stopJobs(poetryFlow);
});

/**
 * Runs `flow`'s installed `standards-upgrade` with `args`.
 * @param {Flow} at @param {readonly string[]} args
 */
function upgrade(at, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(at.root, "standards-upgrade.mjs"), ...args],
    { cwd: at.root, env: at.env, encoding: "utf8", timeout: ENTRY_MS },
  );
  /** @type {any} */
  let line = null;
  if (result.stdout.trim() !== "") {
    line = JSON.parse(result.stdout);
  }
  return { code: result.status, stderr: result.stderr, line };
}

/** @param {Flow} at @returns {ReturnType<typeof upgrade>} a fresh assessment of the base */
function assessBase(at) {
  const out = fs.mkdtempSync(path.join(at.tmp, "assessment-"));
  return upgrade(at, [
    "assess",
    "--config",
    at.config,
    "--repo",
    "o/r",
    "--out",
    out,
  ]);
}

/** @param {Flow} at @returns {string} what GitHub and the origin show, for comparison */
function visible(at) {
  const { issues, comments, prs, repoLabels } = readWorld(at.ghDir);
  const refs = bareGit(at.origin, ["show-ref"]);
  return JSON.stringify({ issues, comments, prs, repoLabels, refs });
}

/** @param {Flow} at @param {number} n */
function apply(at, n) {
  return upgrade(at, ["apply", "--config", at.config, "--issue", String(n)]);
}

/**
 * The Implementation the fake pi performs on an admitted plan: write
 * `files` under the checkout and commit them as `message`.
 * @param {Record<string, string>} files @param {string} message @param {string} summary
 */
function implementor(files, message, summary) {
  const paths = Object.keys(files).map((file) => `repo/${file}`);
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([file, text]) => [`repo/${file}`, text]),
    ),
    commits: [["-m", message, "--", ...paths]],
    output: { outcome: "done", summary },
  };
}

/** @type {Delivery} */
const NODE_DELIVERY = {
  flow: () => flow,
  files: {
    ".github/workflows/ci.yml": WORKFLOW,
    "package.json": `${JSON.stringify({
      name: "greeter",
      private: true,
      engines: { node: ">=24" },
      scripts: { test: "node --test" },
    })}\n`,
  },
  message: "Run the tests in CI",
  summary: "Added CI and a real test script",
};
/** @type {Delivery} */
const POETRY_DELIVERY = {
  flow: () => poetryFlow,
  files: {
    ".github/workflows/ci.yml": POETRY_WORKFLOW,
    "tests/test_aoc.py": REAL_TEST,
  },
  message: "Test the solver and run pytest in CI",
  summary: "Replaced the placeholder test and added CI",
};

/**
 * Assesses a flow's base, files the plan as alice, admits it, then runs the
 * admitted Implementation through the installed caller with the fake pi
 * committing `files`. Returns what each step showed, for the test to compare.
 * @param {Delivery} delivery
 */
async function delivered(delivery) {
  const at = delivery.flow();
  const head = refIn(at.origin, `refs/heads/${BASE}`);
  const untouched = visible(at);
  const assessed = assessBase(at);
  const plan = fs.readFileSync(assessed.line.plan, "utf8");
  const assessWrote = visible(at) !== untouched;
  openFlowIssue(at, "alice", "Standards upgrade", plan);
  const seen = visible(at);
  const admitted = apply(at, ISSUE);
  const applyWrote = visible(at) !== seen;
  scriptPi(at, {
    implementor: [
      implementor(delivery.files, delivery.message, delivery.summary),
    ],
  });
  const run = fs.mkdtempSync(path.join(at.tmp, "caller-run-"));
  fs.writeFileSync(
    path.join(run, "run.json"),
    JSON.stringify({ maxJobs: 1, maxAttempts: 1 }),
  );
  const { line } = await callerJob(at, run, admitted.line.stage, {
    branch: admitted.line.branch,
  });
  const prs = readWorld(at.ghDir).prs.filter((pr) => pr.head === BRANCH);
  return {
    plan,
    seen: {
      assessed: [
        assessed.code,
        assessed.line.disposition,
        assessed.line.verdict,
      ],
      assessWrote,
      admitted: [admitted.code, admitted.line.branch, admitted.line.stage],
      admittedSource: admitted.line.source === head,
      applyWrote,
      end: line.end,
      prs: prs.map((pr) => ({ draft: pr.isDraft, base: pr.base })),
      baseMoved: refIn(at.origin, `refs/heads/${BASE}`) !== head,
      files: Object.fromEntries(
        Object.keys(delivery.files).map((file) => [
          file,
          `${bareGit(at.origin, ["show", `refs/heads/${BRANCH}:${file}`])}\n`,
        ]),
      ),
      creators: ghAccountCalls(at.ghDir)
        .filter(({ args }) => args[0] === "pr" && args[1] === "create")
        .map(({ login }) => login),
    },
  };
}

/**
 * What a delivery of `delivery` that assessed `disposition` should show.
 * @param {Delivery} delivery @param {string} disposition
 */
function expectedOf(delivery, disposition) {
  return {
    assessed: [0, disposition, "not-acceptable"],
    assessWrote: false,
    admitted: [0, BRANCH, "implement"],
    admittedSource: true,
    applyWrote: false,
    end: "next",
    prs: [{ draft: true, base: BASE }],
    baseMoved: false,
    files: delivery.files,
    creators: ["dev-bot"],
  };
}

describe("standards upgrade through issue delivery", () => {
  test("carries an assessed plan through the caller to one draft PR", async () => {
    const { plan, seen } = await delivered(NODE_DELIVERY);
    assert.deepEqual(seen, expectedOf(NODE_DELIVERY, "node-npm"));
    assert.match(plan, NPM_CHECKS);
  });

  test("carries an assessed Poetry plan through the caller to one draft PR", async () => {
    const { plan, seen } = await delivered(POETRY_DELIVERY);
    assert.deepEqual(seen, expectedOf(POETRY_DELIVERY, "python-poetry"));
    assert.match(plan, POETRY_CHECKS);
  });

  test("refuses a plan filed by a pipeline account, beside another plan or against a moved base", () => {
    const assessed = assessBase(flow);
    assert.equal(assessed.code, 0, assessed.stderr);
    assert.equal(assessed.line.verdict, "not-acceptable");
    const plan = fs.readFileSync(assessed.line.plan, "utf8");
    const first = 40;
    openIssue(flow.ghDir, {
      number: first,
      title: "Upgrade",
      body: plan,
      login: "dev-bot",
    });
    const seen = visible(flow);
    const byBot = apply(flow, first);
    assert.equal(byBot.code, 2);
    assert.match(byBot.stderr, NOT_ALLOWED);

    const second = 41;
    openIssue(flow.ghDir, {
      number: second,
      title: "Upgrade",
      body: plan,
      login: "alice",
    });
    const beside = apply(flow, second);
    assert.equal(beside.code, 2);
    assert.match(beside.stderr, ANOTHER_PLAN);

    advanceTarget(flow, { "notes.txt": "moved\n" });
    const moved = apply(flow, second);
    assert.equal(moved.code, 2);
    assert.match(moved.stderr, MOVED);
    assert.equal(
      JSON.parse(visible(flow)).prs.length,
      JSON.parse(seen).prs.length,
    );
  });
});
