// The stage job end to end: `node src/job.ts` with a fake ops.mjs in a
// temporary pipeline root and a fake `pi` first on PATH. Each logs what it
// was asked, so the tests see the ops in order and every pi command line.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
} from "./workflow-stages-fixtures.mjs";

const JOB = new URL("../src/job.ts", import.meta.url).pathname;
const AGENTS = new URL("../agents/", import.meta.url).pathname;
const SESSION_KEY = /^i7-spec-\d+\.jsonl$/u;
const SET_ASIDE_SESSION = /^i7-spec-\d+\.[0-9a-z]+\.jsonl$/u;
const ENDS_WITH_OUTPUT_TOOL = /,structured_output$/u;
const NAMES_REVIEW = /review/u;
const NAMES_SPEC = /spec/u;
const STAGE_LIST = /--stage must be one of: triage, spec/u;

// Issue #7 after triage: its plan and draft PR.
const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
  allocated: 50_000,
};
const SPEC = "## Behaviour\n\n1. src/a.ts does the thing.";
const USAGE = { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 400 };

// Answers each op from replies.json and logs the request to ops.log.
const FAKE_OPS = `import fs from "node:fs";
const dir = import.meta.dirname;
const input = fs.readFileSync(0, "utf8");
const request = JSON.parse(input.split("BEGIN_OPS_REQUEST")[1].split("END_OPS_REQUEST")[0]);
fs.appendFileSync(dir + "/ops.log", JSON.stringify(request) + "\\n");
const replies = JSON.parse(fs.readFileSync(dir + "/replies.json", "utf8"));
process.stdout.write("ops: " + request.op + "\\n" + JSON.stringify(replies[request.op]) + "\\n");
`;

// Logs its argv, cwd, stdin and whether its session file was new to
// pi.log, then prints a session that ends on structured_output with the
// details in pi-output.json, writing it to the session file as pi does.
const FAKE_PI = `#!/usr/bin/env node
import fs from "node:fs";
const root = process.env.FAKE_PI_ROOT;
const stdin = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const session = argv[argv.indexOf("--session") + 1];
const fresh = !fs.existsSync(session);
const call = { argv, cwd: process.cwd(), stdin, fresh };
fs.appendFileSync(root + "/pi.log", JSON.stringify(call) + "\\n");
const details = JSON.parse(fs.readFileSync(root + "/pi-output.json", "utf8"));
const usage = ${JSON.stringify(USAGE)};
for (const event of [
  { type: "session", version: 3, id: "s", cwd: process.cwd() },
  { type: "message_end", message: { role: "assistant", content: [], usage, stopReason: "toolUse" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "structured_output", result: { content: [], details }, isError: false },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
  fs.appendFileSync(session, JSON.stringify(event) + "\\n");
}
`;

// A fresh pipeline root, agent dir, worktree and fake bin for one job.
function setUp(replies, piOutput) {
  const tmp = fs.mkdtempSync("/tmp/issue-pipeline-job-");
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "root");
  const bin = path.join(tmp, "bin");
  const agents = path.join(tmp, "agent", "agents", "issue-pipeline");
  const worktree = path.join(tmp, "work");
  for (const dir of [root, bin, agents, worktree]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of fs.readdirSync(AGENTS)) {
    fs.copyFileSync(path.join(AGENTS, file), path.join(agents, file));
  }
  fs.writeFileSync(path.join(root, "ops.mjs"), FAKE_OPS);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "pi-output.json"), JSON.stringify(piOutput));
  const config = path.join(root, "o__r.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      account: "bot",
      allowedUsers: ["alice"],
      commands: { test: "true" },
    }),
  );
  const { claim } = replies;
  claim.paths = { ...claim.paths, worktree };
  fs.writeFileSync(path.join(root, "replies.json"), JSON.stringify(replies));
  return { tmp, root, bin, config, worktree };
}

function runJob(place, stage) {
  return spawnSync(
    process.execPath,
    [
      JOB,
      "--config",
      place.config,
      "--issue",
      "7",
      "--stage",
      stage,
      "--lane",
      "L",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries([
          ["PATH", `${place.bin}${path.delimiter}${process.env.PATH}`],
          ["ISSUE_PIPELINE_ROOT", place.root],
          ["PI_CODING_AGENT_DIR", path.join(place.tmp, "agent")],
          ["FAKE_PI_ROOT", place.root],
        ]),
      },
    },
  );
}

function logOf(place, name) {
  const file = path.join(place.root, name);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function flagValue(argv, flag) {
  return argv[argv.indexOf(flag) + 1];
}

test("a stage job runs the spec stage, releases the issue at implement and prints one summary line", () => {
  const place = setUp(
    {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("spec", TRIAGED),
    },
    replyWith({ decision: "ready", spec: SPEC, questions: [] })
      .structuredOutput,
  );
  const r = runJob(place, "spec");
  assert.equal(r.status, 0, r.stderr);
  const ops = logOf(place, "ops.log");
  assert.deepEqual(
    ops.map(({ op }) => op),
    ["sweep", "claim", "save-state", "release", "cleanup"],
  );
  assert.equal(ops[0].only, ISSUE);
  assert.equal(ops[0].lane, "L");
  const release = ops.find(({ op }) => op === "release");
  assert.equal(release.state.stage, "implement");
  assert.equal(
    release.state.reportedTokens,
    USAGE.input + USAGE.output + USAGE.cacheRead + USAGE.cacheWrite,
  );
  const calls = logOf(place, "pi.log");
  assert.equal(calls.length, 1);
  const [{ argv, cwd, stdin }] = calls;
  assert.equal(cwd, fs.realpathSync(place.worktree));
  assert.ok(stdin.length > 0);
  const session = flagValue(argv, "--session");
  assert.equal(
    path.dirname(session),
    path.join(place.root, "runs/o__r/issue-7/sessions"),
  );
  assert.match(path.basename(session), SESSION_KEY);
  assert.equal(flagValue(argv, "--model"), "anthropic/claude-opus-5-5");
  assert.match(flagValue(argv, "--tools"), ENDS_WITH_OUTPUT_TOOL);
  assert.ok(argv.includes(path.join(place.root, "structured-output.mjs")));
  assert.ok(fs.existsSync(flagValue(argv, "--output-schema")));
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.lane, "L");
  assert.equal(summary.items[0].issue, ISSUE);
  assert.equal(summary.items[0].stage, "implement");
});

test("a second stage job for the same stage starts a fresh pi session and keeps the first aside", () => {
  const place = setUp(
    {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("spec", TRIAGED),
    },
    replyWith({ decision: "ready", spec: SPEC, questions: [] })
      .structuredOutput,
  );
  for (const run of [runJob(place, "spec"), runJob(place, "spec")]) {
    assert.equal(run.status, 0, run.stderr);
  }
  const calls = logOf(place, "pi.log");
  assert.equal(calls.length, 2);
  const [first, second] = calls.map(({ argv }) => flagValue(argv, "--session"));
  assert.equal(second, first);
  assert.deepEqual(
    calls.map(({ fresh }) => fresh),
    [true, true],
  );
  const aside = fs
    .readdirSync(path.dirname(first))
    .filter((name) => SET_ASIDE_SESSION.test(name));
  assert.equal(aside.length, 1);
  assert.equal(
    fs.readFileSync(path.join(path.dirname(first), aside[0]), "utf8"),
    fs.readFileSync(first, "utf8"),
  );
});

test("a stage job for an issue saved at another stage releases it untouched as wrong-stage", () => {
  const place = setUp(
    {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("review", TRIAGED),
    },
    {},
  );
  const r = runJob(place, "spec");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    logOf(place, "ops.log").map(({ op }) => op),
    ["sweep", "claim", "release", "cleanup"],
  );
  assert.deepEqual(logOf(place, "pi.log"), []);
  const [item] = JSON.parse(r.stdout).items;
  assert.equal(item.outcome, "wrong-stage");
  assert.match(item.reason, NAMES_REVIEW);
  assert.match(item.reason, NAMES_SPEC);
});

test("a stage job with an unknown stage fails before any op", () => {
  const place = setUp(
    {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("spec", TRIAGED),
    },
    {},
  );
  const r = runJob(place, "nope");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, STAGE_LIST);
  assert.equal(r.stdout, "");
  assert.deepEqual(logOf(place, "ops.log"), []);
});
