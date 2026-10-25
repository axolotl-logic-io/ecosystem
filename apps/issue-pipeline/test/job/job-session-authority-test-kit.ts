// Write authority is each session's own (src/job/role-session.ts through
// launch.ts and session-hooks.ts): a Sync task job runs the Developer's
// committing resolver session, and a merge job only the reviewer's
// read-only security review, though both agents' definitions edit, write
// and run commands. Only the committing session gets pipeline_commit, a
// commit scope and those tools; neither gets a GitHub token; job.json and the usage
// records name each session's authority and phase; each session's pi gets
// its phase's pinned prompt page appended to its system prompt, byte for
// byte, though the page changed after it was pinned; and a session the stage
// doesn't allow, or one the job pinned no prompt for, never starts pi.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Config } from "../../src/config.ts";
import type { RunArgs } from "../../src/job/args.ts";
import type { Control } from "../../src/job/control.ts";
import type {
  SessionPhase,
  SessionResult,
  SessionSpec,
} from "../../src/job/role-context.ts";
import type { UsageEntry } from "../../src/job/run-usage.ts";
import type { Stage } from "../../src/stages.ts";
import type { CodeMerged } from "../../src/state.ts";
import type { Binding } from "../../src/task-result-records.ts";
import { credentialConfig } from "../credentials-test-kit.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import { TEST_BINDING } from "../job-fixtures.ts";
import { writePrompts } from "../prompt-test-kit.ts";
import { provisionFixture } from "../runtime-fixtures.ts";
import { saveAuthority } from "../write-authority-test-kit.ts";
import type { PiLine, PiStart } from "./job-test-kit.ts";

const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);
const { AGENT_DIR }: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
const tmp = fs.mkdtempSync(path.join(isolatedRoot, "authority-"));
// The kit's temporary HOME holds pi's agent folder.
if (!AGENT_DIR.startsWith(path.dirname(isolatedRoot))) {
  throw new Error("pi's agent folder isn't in the test's temporary home");
}
const agents = path.join(AGENT_DIR, "agents", "issue-pipeline");
const bin = path.join(tmp, "bin");
const { PATH: searchPath = "" }: NodeJS.ProcessEnv = process.env;
fs.mkdirSync(agents, { recursive: true });
fs.mkdirSync(bin);
// The fake pi and the job's gh tokens, which no session may get. Environment
// variables are named by strings, as isolated-root-test-kit.ts names them.
Object.assign(
  process.env,
  Object.fromEntries([
    ["FAKE_PI_ROOT", tmp],
    ["PIPELINE_MODEL_KEY", "offline-fixture-credential"],
    ["PATH", `${bin}${path.delimiter}${searchPath}`],
    ["GH_TOKEN", "gh-secret"],
    ["GITHUB_TOKEN", "github-secret"],
  ]),
);

const { FAKE_PI, outputEnd }: typeof import("../fake-rpc-pi.ts") = await import(
  "../fake-rpc-pi.ts"
);
const { loadConfig, paths }: typeof import("../../src/config.ts") =
  await import("../../src/config.ts");
const { openControl }: typeof import("../../src/job/control.ts") = await import(
  "../../src/job/control.ts"
);
const { COMMIT_SCOPE_ENV }: typeof import("../../src/job/pipeline-commit.ts") =
  await import("../../src/job/pipeline-commit.ts");
const { pinPrompts }: typeof import("../../src/job/prompts.ts") = await import(
  "../../src/job/prompts.ts"
);
const { sessionRunnerOf }: typeof import("../../src/job/role-session.ts") =
  await import("../../src/job/role-session.ts");
const { runUsage }: typeof import("../../src/job/run-usage.ts") = await import(
  "../../src/job/run-usage.ts"
);
const { hooksOf }: typeof import("../../src/job/session-hooks.ts") =
  await import("../../src/job/session-hooks.ts");
const { openStatus }: typeof import("../../src/job/status.ts") = await import(
  "../../src/job/status.ts"
);

const ISSUE = 7;
const DEVELOPER = "issue-pipeline-implementor";
// Lengths of a full commit and of a digest.
const SHA_LENGTH = 40;
const DIGEST_LENGTH = 64;
// A Sync binding the session tests' task job names; no op reads it.
const SYNC_BINDING: Binding = {
  repo: "o/r",
  workItem: ISSUE,
  task: "Sync",
  revision: {
    code: "a".repeat(SHA_LENGTH),
    inputs: "b".repeat(DIGEST_LENGTH),
    policy: "c".repeat(DIGEST_LENGTH),
  },
  target: { branch: "main", commit: "d".repeat(SHA_LENGTH) },
};
const STAGE: Stage = "merge";
const REVIEWER = "issue-pipeline-reviewer";
const REPLY = { outcome: "done" };

// Reviewer and Developer definitions that edit, write and run commands, as
// hardening and Sync's resolver need.
fs.writeFileSync(
  path.join(agents, `${REVIEWER}.md`),
  "---\nname: issue-pipeline-reviewer\ntools: read, grep, find, ls, bash, edit, write\n---\nReview.\n",
);
fs.writeFileSync(
  path.join(agents, `${DEVELOPER}.md`),
  "---\nname: issue-pipeline-implementor\ntools: read, grep, find, ls, bash, edit, write\n---\nDevelop.\n",
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
    ...credentialConfig("bot"),
    allowedUsers: ["alice"],
    commands: { test: "true" },
    runtime: provisionFixture(tmp),
  }),
);

// Returns what each pi the fake started logged as it started
function piStarts(): PiStart[] {
  const file = path.join(tmp, "pi.log");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line): PiLine => JSON.parse(line))
    .filter((entry): entry is PiStart => "argv" in entry);
}

// Returns what pi appends
function appendedOf(argv: readonly string[]): string[] {
  return argv.flatMap((arg, i) => {
    if (argv[i - 1] === "--append-system-prompt") {
      return [arg];
    }
    return [];
  });
}

// Returns the --tools list
function toolsOf(argv: readonly string[]): string[] {
  return String(argv[argv.indexOf("--tools") + 1]).split(",");
}

// A merge job's session runner, or a Sync task job's at the merge stage,
// with its status, control, usage entries and prompt folder, its prompts
// pinned from that folder as a `pinnedAs` job pins them.
async function openMergeJob(
  pinnedAs: Stage = STAGE,
  { merged = false, task }: { merged?: boolean; task?: "sync" } = {},
): Promise<{
  session: (spec: SessionSpec) => Promise<SessionResult>;
  runDir: string;
  control: Control;
  appended: UsageEntry[];
  promptsDir: string;
  cfg: Config;
}> {
  const promptsDir = writePrompts(fs.mkdtempSync(path.join(tmp, "root-")));
  const prompts = pinPrompts(promptsDir, pinnedAs, "lawd", task ?? null);
  const cfg = loadConfig(configFile);
  let codeMerged: CodeMerged | null = null;
  if (merged === true) {
    codeMerged = { pr: 42, sha: "merged-code" };
  }
  saveAuthority(cfg, {
    ...newIssueState(ISSUE),
    stage: STAGE,
    branch: "agent/issue-7",
    codeMerged,
  });
  const runDir = paths.runDir(cfg, ISSUE);
  const cwd = fs.mkdtempSync(path.join(tmp, "job-"));
  const identity = { id: "job-1", startedAt: new Date().toISOString() };
  const status = openStatus(runDir, {
    ...identity,
    issue: ISSUE,
    stage: STAGE,
    lane: null,
    socket: "",
    prompts: prompts.pinned,
  });
  const control = await openControl(
    runDir,
    () => ({ pushed: "none", pushError: null }),
    TEST_BINDING,
  );
  let request: RunArgs["task"] = null;
  if (task !== undefined) {
    request = { name: task, task: "Sync", binding: SYNC_BINDING };
  }
  const args: RunArgs = {
    kind: "run",
    config: configFile,
    issue: ISSUE,
    stage: STAGE,
    branch: "agent/issue-7",
    task: request,
  };
  // These sessions test write authority; invocation ownership is
  // job/job-writer-fence.test.ts's.
  const where = {
    cwd,
    repo: cwd,
    from: process.env,
    job: identity,
    execution: TEST_BINDING,
    owner: (): undefined => undefined,
  };
  const hooks = hooksOf(cfg, args, { status, control }, where);
  const appended: UsageEntry[] = [];
  const session = sessionRunnerOf({
    stage: STAGE,
    task: task ?? null,
    prompts,
    hooks,
    status,
    stopping: control.stopping,
    usage: runUsage(STAGE, new Date()),
    append: (entry: UsageEntry) => {
      appended.push(entry);
      return Promise.resolve();
    },
  });
  return { session, runDir, control, appended, promptsDir, cfg };
}

function reviewerSpec(commits: boolean, phase?: SessionPhase): SessionSpec {
  const spec: SessionSpec = {
    agent: REVIEWER,
    model: "openai/gpt-6.1-sol",
    task: "Do it.",
    schema: z.object({ outcome: z.string() }),
    commits,
  };
  if (phase !== undefined) {
    spec.phase = phase;
  }
  return spec;
}

function developerSpec(commits: boolean, phase: SessionPhase): SessionSpec {
  return { ...reviewerSpec(commits, phase), agent: DEVELOPER };
}

// Returns a session entry's state
function stateOf(entry: UsageEntry): string | null {
  if (entry.kind === "session") {
    return entry.state;
  }
  return null;
}

export {
  appendedOf,
  COMMIT_SCOPE_ENV,
  developerSpec,
  ISSUE,
  openMergeJob,
  piStarts,
  reviewerSpec,
  STAGE,
  stateOf,
  toolsOf,
};
