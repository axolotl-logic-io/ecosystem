// The stage job's test kit: `node src/job.ts` with a fake ops.mjs in a
// temporary pipeline root and a fake RPC `pi` first on PATH. Each logs what it
// was asked, so the tests see the ops in order, every pi command line and
// every RPC command pi got. A job startJob started, and every pi in the
// place's pi.log, are no longer running once the test ends.

import type { ChildProcess, SpawnSyncReturns } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { InvocationBinding } from "../../src/coordination.ts";
import type { LaunchRecord } from "../../src/job/launch-record.ts";
import type { PathScope } from "../../src/job/pipeline-commit.ts";
import type { StatusFile } from "../../src/job/status.ts";
import type { IssueState } from "../../src/state.ts";
import { endsWithTest, killGroup } from "../bounded-test-kit.ts";
import { credentialConfig } from "../credentials-test-kit.ts";
import { FAKE_PI } from "../fake-rpc-pi.ts";
import { seedOrigin } from "../job-git-test-kit.ts";
import { writePrompts } from "../prompt-test-kit.ts";
import { provisionFixture } from "../runtime-fixtures.ts";
import { installJobAuthority } from "./fake-job-authority.ts";

const JOB: string = new URL("../../src/job.ts", import.meta.url).pathname;
const OPS: string = new URL("../../src/ops.ts", import.meta.url).pathname;
const AGENTS: string = new URL("../../agents/", import.meta.url).pathname;
// runJob's bound on a job's run. A spawnSync blocks the event loop, and the
// per-test timeout with it, so this bound sits below that timeout
// (`--test-timeout` in package.json's check scripts); a run past it is killed and
// ends with a null status. It covers one job run to its end: the slowest
// measured was 8.2 s, in a full `node --test` run beside three more in a
// copy of the checkout, at 1-minute load averages of up to 130 on 10 cores
// (2026-10-17). It is over 3 times that.
const RUN_JOB_MS = 30_000;
// Where setUp makes each job's temporary folder, and its pipeline root.
const TEMPORARY_ROOT = "/tmp/issue-pipeline-job-";

interface Place {
  tmp: string;
  root: string;
  bin: string;
  config: string;
  worktree: string;
  runDir: string;
  // the repo's bare origin
  origin: string;
  // the root's prompts/ folder, holding every prompt page
  prompts: string;
}

// A fresh pipeline root, agent dir, worktree, fake bin and bare origin
// seeded with a base commit for one job, with every prompt page in the
// root's prompts/.
// extraConfig: more config keys
function setUp(
  replies: Record<string, unknown>,
  script: object,
  extraConfig: Record<string, unknown> = {},
): Place {
  const tmp = fs.mkdtempSync(TEMPORARY_ROOT);
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "root");
  const bin = path.join(tmp, "bin");
  const agents = path.join(tmp, "agent", "agents", "issue-pipeline");
  const worktree = path.join(tmp, "work");
  for (const dir of [root, bin, agents, worktree, homeOf(tmp)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The job runs in this root, never the machine's installed one.
  if (!(root.startsWith(TEMPORARY_ROOT) && fs.statSync(root).isDirectory())) {
    throw new Error(`the job's root ${root} isn't a temporary folder`);
  }
  for (const file of fs.readdirSync(AGENTS)) {
    fs.copyFileSync(path.join(AGENTS, file), path.join(agents, file));
  }
  installJobAuthority(root, bin, replies);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  const seeded = seedOrigin(tmp);
  const config = path.join(root, "o__r.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      ...credentialConfig("bot"),
      allowedUsers: ["alice"],
      commands: { test: "true" },
      ...seeded.config,
      runtime: provisionFixture(root),
      ...extraConfig,
    }),
  );
  fs.writeFileSync(path.join(root, "replies.json"), JSON.stringify(replies));
  const runDir = path.join(root, "runs", "o__r", "issue-7");
  const place = {
    tmp,
    root,
    bin,
    config,
    worktree,
    runDir,
    origin: seeded.origin,
    prompts: writePrompts(root),
  };
  setScript(place, script);
  endsWithTest(() => {
    // Each fake pi leads its own process group.
    for (const { pid } of piStarts(place)) {
      killGroup(pid);
    }
  });
  return place;
}

// The job's HOME, a folder of its own in the place's temporary folder.
function homeOf(tmp: string): string {
  return path.join(tmp, "home");
}

function setScript(place: Place, script: object): void {
  const file = path.join(place.root, "pi-script.json");
  fs.writeFileSync(file, JSON.stringify(script));
}

function jobEnv(
  place: Place,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  // A suite run inside a committing pipeline session leaves out that
  // session's commit scope, which no test's job is given.
  const {
    PATH: searchPath,
    ISSUE_PIPELINE_COMMIT_SCOPE: _sessionScope,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    ...extraEnv,
    ...Object.fromEntries([
      ["PATH", `${place.bin}${path.delimiter}${searchPath}`],
      ["HOME", homeOf(place.tmp)],
      ["ISSUE_PIPELINE_ROOT", place.root],
      ["PI_CODING_AGENT_DIR", path.join(place.tmp, "agent")],
      ["FAKE_PI_ROOT", place.root],
      ["PIPELINE_MODEL_KEY", "offline-fixture-credential"],
    ]),
  };
}

// The branch the job tests assign issue #7: its own.
const ISSUE_BRANCH = "agent/issue-7";

// The job's argv for issue #7 with `args`, which with a stage assign it
// ISSUE_BRANCH unless they name their own.
function argvOf(place: Place, args: readonly string[]): string[] {
  const argv = [JOB, "--config", place.config, "--issue", "7", ...args];
  if (!args.includes("--stage")) {
    return argv;
  }
  if (!args.some((arg) => arg.startsWith("--branch"))) {
    argv.push("--branch", ISSUE_BRANCH);
  }
  return argv;
}

// Runs the job to its end with `args` after its config and issue.
// extraEnv: more job env
function runJob(
  place: Place,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, argvOf(place, args), {
    encoding: "utf8",
    env: jobEnv(place, extraEnv),
    timeout: RUN_JOB_MS,
    killSignal: "SIGKILL",
  });
}

// Runs the real ops CLI (src/ops.ts), not the place's fake ops, on `request`
// with the job's environment, and returns its reply.
function runRealOps(place: Place, request: object): unknown {
  const r = spawnSync(process.execPath, [OPS], {
    encoding: "utf8",
    env: jobEnv(place, {}),
    input: `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`,
    timeout: RUN_JOB_MS,
    killSignal: "SIGKILL",
  });
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null");
}

// A request the fake ops got, as ops.log keeps it: its op, the frame every
// request carries (src/job/ops-request.ts) and the op's own fields a test
// reads.
interface OpsLine {
  op: string;
  lane: string;
  // the issue an op is for
  number?: number;
  execution: InvocationBinding;
  checkout: { branch: string; [field: string]: unknown };
  // the state a save-state, release, stop or ask saves
  state?: IssueState;
  // a stop's code and reason
  code?: string;
  reason?: string;
  // a post's comments
  comments?: { number: number; key: string; body: string }[];
}

// A start of the fake pi, as it logs it in pi.log (test/fake-rpc-pi.ts).
interface PiStart {
  argv: string[];
  cwd: string;
  // the HEAD and branch of its code checkout; null where it has none
  head: string | null;
  branch: string | null;
  pid: number;
  // whether its session file was new
  fresh: boolean;
  // the names in its env
  env: string[];
  ghToken: string | null;
  // its parsed ISSUE_PIPELINE_COMMIT_SCOPE; null when unset
  commitScope: (PathScope & { root: string }) | null;
}

// An RPC command the fake pi read: a prompt's or a steer's message.
interface PiCommand {
  id?: string;
  type: string;
  message?: string;
}

// A line of pi.log: a start, an RPC command read, a commit its script made or
// a mark it played, each command and mark with its launch's name.
type PiLine =
  | PiStart
  | { command: PiCommand; name?: string }
  | { committed: string }
  | { mark: string; name?: string };

interface JobEnd {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Starts the job with `args` after its config and issue; `end` resolves
// once it exits.
// extraEnv: more job env
function startJob(
  place: Place,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): { child: ChildProcess; end: Promise<JobEnd> } {
  const child = spawn(process.execPath, argvOf(place, args), {
    env: jobEnv(place, extraEnv),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  endsWithTest(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  const end: Promise<JobEnd> = new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, end };
}

// The complete JSON lines of the root's log `name`, or none if it isn't
// there; a line still being appended is left out. Line: what the log's lines
// hold, as its writer logs them.
function logOf<Line = unknown>(place: Place, name: string): Line[] {
  const file = path.join(place.root, name);
  if (!fs.existsSync(file)) {
    return [];
  }
  const text = fs.readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .slice(0, -1)
    .map((line): Line => JSON.parse(line));
}

// Returns pi's starts, in order
function piStarts(place: Place): PiStart[] {
  return logOf<PiLine>(place, "pi.log").filter(
    (entry): entry is PiStart => "argv" in entry,
  );
}

// Returns the RPC commands pi read
function piCommands(place: Place): PiCommand[] {
  return logOf<PiLine>(place, "pi.log")
    .filter((entry) => "command" in entry)
    .map(({ command }) => command);
}

// Returns the job's job.json, or null
function statusOf(place: Place): StatusFile | null {
  const file = path.join(place.runDir, "job.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// status: a job.json, or null
// Returns its session's launch, or null
function sessionOf(status: StatusFile | null): LaunchRecord | null {
  return status?.launches.find(({ kind }) => kind === "session") ?? null;
}

function flagValue(argv: readonly string[], flag: string): string {
  return String(argv[argv.indexOf(flag) + 1]);
}

export type { JobEnd, OpsLine, PiCommand, PiLine, PiStart, Place };
export {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  runRealOps,
  sessionOf,
  setScript,
  setUp,
  startJob,
  statusOf,
};
