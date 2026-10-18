// @ts-check
// Write authority is each session's own (src/job/role-session.ts through
// launch.ts and session-hooks.ts): one merge job runs the reviewer's
// committing integration session and then its read-only final security
// review, with the same installed agent, whose definition edits, writes and
// runs commands. Only the committing session gets pipeline_commit, a commit
// scope and those tools; neither gets a GitHub token; job.json and the usage
// records name each session's authority and phase; each session's pi gets
// its phase's pinned prompt page appended to its system prompt, byte for
// byte, though the page changed after it was pinned; and a session the stage
// doesn't allow, or one the job pinned no prompt for, never starts pi.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { pageTextOf, writeBrain } from "./brain-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { AGENT_DIR } = await import("../src/pipeline-root.ts");
const tmp = fs.mkdtempSync(path.join(isolatedRoot, "authority-"));
// The kit's temporary HOME holds pi's agent folder.
if (!AGENT_DIR.startsWith(path.dirname(isolatedRoot))) {
  throw new Error("pi's agent folder isn't in the test's temporary home");
}
const agents = path.join(AGENT_DIR, "agents", "issue-pipeline");
const bin = path.join(tmp, "bin");
const { PATH: searchPath = "" } = process.env;
fs.mkdirSync(agents, { recursive: true });
fs.mkdirSync(bin);
// The fake pi and the job's gh tokens, which no session may get. Environment
// variables are named by strings, as isolated-root-test-kit.mjs names them.
Object.assign(
  process.env,
  Object.fromEntries([
    ["FAKE_PI_ROOT", tmp],
    ["PATH", `${bin}${path.delimiter}${searchPath}`],
    ["GH_TOKEN", "gh-secret"],
    ["GITHUB_TOKEN", "github-secret"],
  ]),
);

const { FAKE_PI, outputEnd } = await import("./fake-rpc-pi.mjs");
const { loadConfig, paths } = await import("../src/config.ts");
const { openBrain } = await import("../src/job/brain.ts");
const { openControl } = await import("../src/job/control.ts");
const { COMMIT_SCOPE_ENV } = await import("../src/job/pipeline-commit.ts");
const { sessionRunnerOf } = await import("../src/job/role-session.ts");
const { runUsage } = await import("../src/job/run-usage.ts");
const { hooksOf } = await import("../src/job/session-hooks.ts");
const { openStatus } = await import("../src/job/status.ts");

/** @import { UsageEntry } from "../src/job/run-usage.ts" */
/** @import { SessionPhase, SessionSpec } from "../src/job/role-context.ts" */
/** @import { RunArgs } from "../src/job/args.ts" */

const ISSUE = 7;
/** @type {import("../src/stages.ts").Stage} */
const STAGE = "merge";
const REVIEWER = "issue-pipeline-reviewer";
const WRITES = ["bash", "edit", "write", "pipeline_commit"];
const REPLY = { outcome: "done" };
const REFUSED_PHASE = /security-review session can't set commits true/u;
const NO_PROMPT = /pinned no prompt for this merge session/u;
const INTEGRATION_PAGE = "Pipeline-Prompt-Integration.md";
const SECURITY_PAGE = "Pipeline-Prompt-Security.md";

// A reviewer definition that edits, writes and runs commands, as the
// reviewer's hardening and integration need.
fs.writeFileSync(
  path.join(agents, `${REVIEWER}.md`),
  "---\nname: issue-pipeline-reviewer\ntools: read, grep, find, ls, bash, edit, write\n---\nReview.\n",
);
fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
fs.writeFileSync(
  path.join(tmp, "pi-script.json"),
  JSON.stringify({ events: [outputEnd(REPLY)] }),
);
const configFile = path.join(tmp, "config.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    repo: "o/r",
    account: "bot",
    allowedUsers: ["alice"],
    commands: { test: "true" },
  }),
);

/** @returns {any[]} what each pi the fake started logged as it started */
function piStarts() {
  const file = path.join(tmp, "pi.log");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => "argv" in entry);
}

/** @param {readonly string[]} argv @returns {string[]} what pi appends */
function appendedOf(argv) {
  return argv.flatMap((arg, i) => {
    if (argv[i - 1] === "--append-system-prompt") {
      return [arg];
    }
    return [];
  });
}

/** @param {readonly string[]} argv @returns {string[]} the --tools list */
function toolsOf(argv) {
  return String(argv[argv.indexOf("--tools") + 1]).split(",");
}

// A merge job's session runner, with its status, control, usage entries and
// brain, its prompts pinned from that brain as a `pinnedAs` job pins them.
async function openMergeJob(pinnedAs = STAGE) {
  const brainDir = writeBrain(fs.mkdtempSync(path.join(tmp, "brain-")));
  const brain = openBrain(brainDir, pinnedAs);
  const cfg = loadConfig(configFile);
  const runDir = paths.runDir(cfg, ISSUE);
  const cwd = fs.mkdtempSync(path.join(tmp, "job-"));
  const identity = { id: "job-1", startedAt: new Date().toISOString() };
  const status = openStatus(runDir, {
    ...identity,
    issue: ISSUE,
    stage: STAGE,
    lane: null,
    socket: "",
    prompts: brain.pinned,
  });
  const control = await openControl(runDir, () => ({
    pushed: "none",
    pushError: null,
  }));
  /** @type {RunArgs} */
  const args = {
    kind: "run",
    config: configFile,
    issue: ISSUE,
    stage: STAGE,
    branch: "agent/issue-7",
    brainPath: brainDir,
  };
  const where = { cwd, repo: cwd, from: process.env, job: identity };
  const hooks = hooksOf(cfg, args, { status, control }, where);
  /** @type {UsageEntry[]} */
  const appended = [];
  const session = sessionRunnerOf({
    stage: STAGE,
    brain,
    hooks,
    status,
    stopping: control.stopping,
    usage: runUsage(STAGE, new Date()),
    append: (entry) => {
      appended.push(entry);
      return Promise.resolve();
    },
  });
  return { session, runDir, control, appended, brainDir };
}

/** @param {boolean} commits @param {SessionPhase} [phase] @returns {SessionSpec} */
function reviewerSpec(commits, phase) {
  /** @type {SessionSpec} */
  const spec = {
    agent: REVIEWER,
    model: "mock",
    task: "Do it.",
    schema: z.object({ outcome: z.string() }),
    commits,
  };
  if (phase !== undefined) {
    spec.phase = phase;
  }
  return spec;
}

/** @param {UsageEntry} entry @returns {string | null} a session entry's state */
function stateOf(entry) {
  if (entry.kind === "session") {
    return entry.state;
  }
  return null;
}

test("the merge job's integration session commits and its final security review only reads, though both run the same agent", async () => {
  const job = await openMergeJob();
  try {
    const integration = await job.session(reviewerSpec(true, "integration"));
    const review = await job.session(reviewerSpec(false, "security-review"));
    assert.deepEqual([integration.ok, review.ok], [true, true]);
    const [writer, reader] = piStarts();
    for (const tool of WRITES) {
      assert.ok(toolsOf(writer.argv).includes(tool), tool);
      assert.equal(toolsOf(reader.argv).includes(tool), false, tool);
    }
    assert.ok(writer.env.includes(COMMIT_SCOPE_ENV));
    assert.deepEqual(writer.commitScope.repo, { dir: "repo", access: "write" });
    assert.equal(reader.env.includes(COMMIT_SCOPE_ENV), false);
    assert.equal(reader.commitScope, null);
    for (const start of [writer, reader]) {
      assert.equal(start.ghToken, null);
      assert.equal(start.env.includes("GITHUB_TOKEN"), false);
    }
    const status = JSON.parse(
      fs.readFileSync(path.join(job.runDir, "job.json"), "utf8"),
    );
    const launches = status.launches.map((/** @type {any} */ launch) => [
      launch.commits,
      launch.phase,
    ]);
    assert.deepEqual(launches, [
      [true, "integration"],
      [false, "security-review"],
    ]);
    assert.deepEqual(job.appended.map(stateOf), [
      "integration",
      "security-review",
    ]);
  } finally {
    job.control.close();
  }
});

test("a session whose authority its phase or stage forbids, or that the job pinned no prompt for, is refused before pi starts", async () => {
  const job = await openMergeJob();
  const before = piStarts().length;
  try {
    const result = await job.session(reviewerSpec(true, "security-review"));
    assert.ok(!result.ok);
    assert.match(result.error, REFUSED_PHASE);
    const other = await job.session({
      ...reviewerSpec(false),
      agent: "issue-pipeline-author",
    });
    assert.equal(other.ok, false);
    const unpinned = await openMergeJob("author");
    const unprompted = await unpinned.session(
      reviewerSpec(true, "integration"),
    );
    unpinned.control.close();
    assert.ok(!unprompted.ok);
    assert.match(unprompted.error, NO_PROMPT);
    assert.equal(piStarts().length, before);
  } finally {
    job.control.close();
  }
});

test("each session's pi gets its phase's page appended to its system prompt as pinned, though the page changed after", async () => {
  const job = await openMergeJob();
  const before = piStarts().length;
  fs.writeFileSync(path.join(job.brainDir, INTEGRATION_PAGE), "Edited.\n");
  try {
    await job.session(reviewerSpec(true, "integration"));
    await job.session(reviewerSpec(false, "security-review"));
    const starts = piStarts().slice(before);
    assert.deepEqual(
      starts.map(({ argv }) => appendedOf(argv)),
      [[pageTextOf(INTEGRATION_PAGE)], [pageTextOf(SECURITY_PAGE)]],
    );
    const status = JSON.parse(
      fs.readFileSync(path.join(job.runDir, "job.json"), "utf8"),
    );
    /** @type {{ page: string, sha256: string }[]} */
    const pages = status.prompts.map((/** @type {any} */ { page, sha256 }) => ({
      page,
      sha256,
    }));
    assert.deepEqual(
      pages.map(({ page }) => page),
      [INTEGRATION_PAGE, SECURITY_PAGE],
    );
    const launched = status.launches.slice(-2);
    assert.deepEqual(
      launched.map((/** @type {any} */ l) => l.prompt),
      pages,
    );
    const used = job.appended.flatMap((entry) => {
      if (entry.kind === "session") {
        return [entry.prompt.sha256];
      }
      return [];
    });
    assert.deepEqual(
      used,
      pages.map(({ sha256 }) => sha256),
    );
  } finally {
    job.control.close();
  }
});
