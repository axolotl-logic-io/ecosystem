// @ts-check
// The standards upgrade end to end (#129): the built `standards-upgrade`
// assesses a Node repository on a local origin, an allow-listed person files
// its plan as the upgrade issue, `apply` admits it, and the installed caller
// runs the real Implementation job, which delivers the change as one draft
// PR from the development account. The assessment and admission write
// nothing; the chain's existing ops do every write. Plans filed by the wrong
// person, against a moved base, or beside another open plan are refused.
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
const NOT_ALLOWED = /isn't an allow-listed collaborator/u;
const MOVED = /reassess and file a new plan/u;
const ANOTHER_PLAN = /already carries an open upgrade plan/u;

/** @type {import("../pipeline-flow-test-kit.mjs").Flow} */
let flow;

before(() => {
  flow = setUpFlow();
  advanceTarget(flow, {
    "package.json": `${JSON.stringify({
      name: "greeter",
      private: true,
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    })}\n`,
  });
});
after(() => stopJobs(flow));

/**
 * Runs the installed `standards-upgrade` with `args`.
 * @param {readonly string[]} args
 */
function upgrade(args) {
  const result = spawnSync(
    process.execPath,
    [path.join(flow.root, "standards-upgrade.mjs"), ...args],
    { cwd: flow.root, env: flow.env, encoding: "utf8", timeout: ENTRY_MS },
  );
  /** @type {any} */
  let line = null;
  if (result.stdout.trim() !== "") {
    line = JSON.parse(result.stdout);
  }
  return { code: result.status, stderr: result.stderr, line };
}

/** @returns {ReturnType<typeof upgrade>} a fresh assessment of the base */
function assessBase() {
  const out = fs.mkdtempSync(path.join(flow.tmp, "assessment-"));
  const run = upgrade([
    "assess",
    "--config",
    flow.config,
    "--repo",
    "o/r",
    "--out",
    out,
  ]);
  return run;
}

/** @returns {string} what GitHub and the origin show, for comparison */
function visible() {
  const { issues, comments, prs, repoLabels } = readWorld(flow.ghDir);
  const refs = bareGit(flow.origin, ["show-ref"]);
  return JSON.stringify({ issues, comments, prs, repoLabels, refs });
}

/** @param {number} n */
function apply(n) {
  return upgrade(["apply", "--config", flow.config, "--issue", String(n)]);
}

describe("standards upgrade through issue delivery", () => {
  test("carries an assessed plan through the caller to one draft PR", async () => {
    const head = refIn(flow.origin, `refs/heads/${BASE}`);
    const untouched = visible();
    const assessed = assessBase();
    assert.equal(assessed.code, 0, assessed.stderr);
    assert.equal(assessed.line.verdict, "not-acceptable");
    const plan = fs.readFileSync(assessed.line.plan, "utf8");
    assert.equal(visible(), untouched);
    openFlowIssue(flow, "alice", "Standards upgrade", plan);
    const seen = visible();
    const admitted = apply(ISSUE);
    assert.equal(admitted.code, 0, admitted.stderr);
    assert.equal(visible(), seen);
    assert.equal(admitted.line.branch, BRANCH);
    assert.equal(admitted.line.source, head);
    assert.equal(admitted.line.stage, "implement");

    scriptPi(flow, {
      implementor: [
        {
          files: {
            "repo/.github/workflows/ci.yml": WORKFLOW,
            "repo/package.json": `${JSON.stringify({
              name: "greeter",
              private: true,
              engines: { node: ">=24" },
              scripts: { test: "node --test" },
            })}\n`,
          },
          commits: [
            [
              "-m",
              "Run the tests in CI",
              "--",
              "repo/.github/workflows/ci.yml",
              "repo/package.json",
            ],
          ],
          output: {
            outcome: "done",
            summary: "Added CI and a real test script",
          },
        },
      ],
    });
    const run = fs.mkdtempSync(path.join(flow.tmp, "caller-run-"));
    fs.writeFileSync(
      path.join(run, "run.json"),
      JSON.stringify({ maxJobs: 1, maxAttempts: 1 }),
    );
    const { line } = await callerJob(flow, run, admitted.line.stage, {
      branch: admitted.line.branch,
    });
    assert.equal(line.end, "next", JSON.stringify(line));

    const world = readWorld(flow.ghDir);
    const prs = world.prs.filter((pr) => pr.head === BRANCH);
    assert.equal(prs.length, 1);
    assert.equal(prs[0]?.isDraft, true);
    assert.equal(prs[0]?.base, BASE);
    assert.equal(refIn(flow.origin, `refs/heads/${BASE}`), head);
    const shown = bareGit(flow.origin, [
      "show",
      `refs/heads/${BRANCH}:.github/workflows/ci.yml`,
    ]);
    assert.equal(`${shown}\n`, WORKFLOW);
    const creators = ghAccountCalls(flow.ghDir)
      .filter(({ args }) => args[0] === "pr" && args[1] === "create")
      .map(({ login }) => login);
    assert.deepEqual(creators, ["dev-bot"]);
  });

  test("refuses a plan filed by a pipeline account, beside another plan or against a moved base", () => {
    const assessed = assessBase();
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
    const seen = visible();
    const byBot = apply(first);
    assert.equal(byBot.code, 2);
    assert.match(byBot.stderr, NOT_ALLOWED);

    const second = 41;
    openIssue(flow.ghDir, {
      number: second,
      title: "Upgrade",
      body: plan,
      login: "alice",
    });
    const beside = apply(second);
    assert.equal(beside.code, 2);
    assert.match(beside.stderr, ANOTHER_PLAN);

    advanceTarget(flow, { "notes.txt": "moved\n" });
    const moved = apply(second);
    assert.equal(moved.code, 2);
    assert.match(moved.stderr, MOVED);
    assert.equal(JSON.parse(visible()).prs.length, JSON.parse(seen).prs.length);
  });
});
