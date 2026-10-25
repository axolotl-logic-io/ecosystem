// The buddy flow tests' kit: a disposable machine on which the real buddy
// runs as the operator installs it. Its pipeline root holds this source's
// build (buddy.mjs, ops.mjs and the session extensions) and prompt pages,
// and pi's agent folder the installed agent definitions. The repository is
// a real local bare origin with a pinned project policy; GitHub is the
// signal tests' fake gh (test/signals/fake-gh.ts) over one world file,
// whose git database is that origin; the model is fake-pi.ts, playing the
// sessions of a plan. Nothing here stands in for the runtime, the tasks,
// the ops or the ledger: tests read back what they wrote to the world, the
// origin and the run observations.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  ACTION_RUN,
  BUDDY_RUN as BUDDY_RUN_OBSERVATION,
} from "../../src/runtime/observations.ts";
import type { FakeIssue, World } from "../signals/fake-github-world.ts";
import { readWorld, writeWorld } from "../signals/fake-github-world.ts";
import {
  baseWorld,
  LANDING,
  ORGANIZATION,
  REPO,
} from "../signals/signal-test-kit.ts";

const SOURCE = path.resolve(import.meta.dirname, "../..");
const FAKE_GH = path.join(SOURCE, "test", "signals", "fake-gh.ts");
const FAKE_PI = path.join(SOURCE, "test", "runtime", "fake-pi.ts");
const DEVELOPER = "lawd-dev";
const HUMAN = "autumn";
const EXECUTABLE = 0o755;
const PRIVATE = 0o600;
const ISSUE = 7;
const MODEL_ID = "fake-model";
const MODEL = `openai/${MODEL_ID}`;
const CONTEXT_WINDOW = 272_000;
const SLUG = REPO.replace("/", "__");
const OVERSTAY_MS = 140_000;
const ENDED = z.strictObject({
  buddyRun: z.uuid(),
  kind: z.enum(["stopped", "failed"]),
  reason: z.string(),
});
const LOGGED = z.strictObject({ login: z.string(), args: z.array(z.string()) });
// The fields of task-result and coordination records the tests read.
const RECORD = z.looseObject({
  kind: z.string(),
  scope: z.string().optional(),
  run: z.unknown().optional(),
  verdict: z.unknown().optional(),
  receipt: z.unknown().optional(),
  consumer: z.unknown().optional(),
});
const COMMIT_RESULT = z.looseObject({
  isError: z.boolean(),
  content: z.array(z.looseObject({ text: z.string() })),
});
const PI_LAUNCH = z.strictObject({
  args: z.array(z.string()),
  prompt: z.string(),
  cwd: z.string(),
  // The ISSUE_PIPELINE_LANE_SLOT the launched process inherited, or null.
  laneSlot: z.string().nullable(),
});

type ActionRun = z.infer<typeof ACTION_RUN>;
type BuddyRun = z.infer<typeof BUDDY_RUN_OBSERVATION>;
type Logged = z.infer<typeof LOGGED>;

// One session fake pi plays.
interface PlannedSession {
  commit: { file: string; content: string; message: string } | null;
  change:
    | "stop-issue"
    | "human-leaves"
    | "posts-fail"
    | "checkpoint-posts-fail"
    | "events-unreadable"
    | null;
  // Whether `change` comes before the commit rather than after it.
  changeFirst: boolean;
  // A file left written and uncommitted in the code checkout.
  strayWrite?: { file: string; content: string };
  awaitAbort: boolean;
  reply: Record<string, unknown> | null;
}

// The buddy one activation runs, as its trusted file names it: the
// Developer hippy, on the development account, or the Gatekeeper lawd, on
// the landing account, each responsible for `tasks`. Only a Gatekeeper
// responsible for Land holds the lander profile and `permissions.land`.
type BuddyChoice =
  | { role: "developer"; tasks: ("implement" | "harden")[] }
  | {
      role: "gatekeeper";
      tasks: ("integrate" | "review-security" | "land" | "complete")[];
    };

// The machine's trusted repository configuration, fixed before any action:
// whether it grants Land (`permissions.land`), which the shared checking
// policy digest covers, its optional lane slot pool (`laneSlots`) and the
// pinned project policy's optional setup command.
interface MachineSetup {
  landPermission: boolean;
  laneSlots?: number;
  setup?: string;
}

// What one buddy run printed and left behind.
interface BuddyOutcome {
  status: number | null;
  stderr: string;
  ended: z.infer<typeof ENDED>;
  run: BuddyRun;
  actions: ActionRun[];
}

interface Machine {
  root: string;
  origin: string;
  work: string;
  pipeline: string;
  world: () => World;
  change: (edit: (world: World) => void) => void;
  calls: () => Logged[];
  // What each pipeline_commit call answered, in order.
  commits: () => z.infer<typeof COMMIT_RESULT>[];
  // The pi launches fake-pi.ts played, in order.
  launches: () => z.infer<typeof PI_LAUNCH>[];
  // Runs `buddy`, from a trusted file of its own, or else the buddy that
  // buddy.json names as it now reads, with `sessions` planned until a poll's first listing is the `stopAtPoll`th,
  // when the fake gh stops it with SIGTERM.
  runBuddy: (
    sessions: PlannedSession[],
    stopAtPoll: number,
    buddy?: BuddyChoice,
  ) => Promise<BuddyOutcome>;
  git: (args: string[]) => string;
  // The commits the project's check ran on, in order.
  checksRun: () => string[];
  // What GitHub answers the landing account's `gh args`, as a person
  // reading it would see; the call is logged like any other.
  readGitHub: (args: string[]) => unknown;
  cleanup: () => void;
}

function git(directory: string, args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function writePrivate(file: string, value: object): void {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, PRIVATE);
}

function writeShim(bin: string, name: string, script: string): void {
  const shim = path.join(bin, name);
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  fs.chmodSync(shim, EXECUTABLE);
}

// Builds this source into the pipeline root and installs its prompts and
// agent definitions, as install.ts lays them out.
function install(pipeline: string, agentDir: string): void {
  const built = spawnSync(process.execPath, ["build.ts", pipeline], {
    cwd: SOURCE,
    encoding: "utf8",
  });
  if (built.status !== 0) {
    throw new Error(`build failed: ${built.stderr}`);
  }
  fs.cpSync(path.join(SOURCE, "prompts"), path.join(pipeline, "prompts"), {
    recursive: true,
  });
  const agents = path.join(agentDir, "agents", "issue-pipeline");
  fs.mkdirSync(agents, { recursive: true });
  for (const file of fs.readdirSync(path.join(SOURCE, "agents"))) {
    fs.copyFileSync(path.join(SOURCE, "agents", file), path.join(agents, file));
  }
}

// Where the project's one check, its test command, appends the commit it
// checked each time it runs.
function checksLog(root: string): string {
  return path.join(root, "checks.log");
}

// The origin with `main` at one commit, a work clone to change it from,
// and a pinned project policy whose shared pool has one model session and
// whose test command passes, logging the commit it checked.
function repository(
  root: string,
  setup: string | undefined,
): {
  origin: string;
  work: string;
  policy: string;
  revision: string;
} {
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const policy = path.join(root, "policy");
  git(root, ["init", "--bare", "--initial-branch=main", origin]);
  // The origin's reflog records each update of its refs, as the tests'
  // account of what moved the target.
  git(origin, ["config", "core.logAllRefUpdates", "always"]);
  git(root, ["clone", "--quiet", origin, work]);
  git(work, ["config", "user.name", "Flow test"]);
  git(work, ["config", "user.email", "flow@example.test"]);
  git(work, ["checkout", "--quiet", "-b", "main"]);
  fs.writeFileSync(path.join(work, "README.md"), "widgets\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "--quiet", "-m", "Target"]);
  git(work, ["push", "--quiet", "origin", "main"]);
  const test = `git rev-parse HEAD >> '${checksLog(root)}'`;
  let commands: { test: string; setup?: string } = { test };
  if (setup !== undefined) {
    commands = { test, setup };
  }
  fs.mkdirSync(policy);
  git(policy, ["init", "--quiet", "--initial-branch=main"]);
  git(policy, ["config", "user.name", "Flow test"]);
  git(policy, ["config", "user.email", "flow@example.test"]);
  git(policy, ["remote", "add", "origin", origin]);
  fs.writeFileSync(
    path.join(policy, ".issue-pipeline.json"),
    JSON.stringify({
      commands,
      resources: { modelSessions: 1 },
    }),
  );
  git(policy, ["add", ".issue-pipeline.json"]);
  git(policy, ["commit", "--quiet", "-m", "Pin settings"]);
  return { origin, work, policy, revision: git(policy, ["rev-parse", "HEAD"]) };
}

// Issue ISSUE, written by the trusted human, labelled start:implement by
// them in event 300.
function startedIssue(): FakeIssue {
  return {
    number: ISSUE,
    title: "Add a widget counter",
    body: "Count the widgets.",
    author: HUMAN,
    pullRequest: false,
    labels: ["start:implement"],
    events: [
      {
        id: 300,
        event: "labeled",
        label: "start:implement",
        actor: HUMAN,
        viaApp: false,
        createdAt: "2026-10-25T10:00:00Z",
      },
    ],
    comments: [],
  };
}

// The repository config's runtime section.
interface ProvisionedRuntime {
  home: string;
  providerExtension: string;
  credentialEnv: string[];
  modelContextWindows: Record<string, number>;
}

// The model runtime the operator provisions: a pi-cliproxyapi 0.4.3
// provider and its reviewed profile in a runtime home of its own. fake-pi.ts
// answers pi's state from this profile as pi would.
function provisionRuntime(root: string): ProvisionedRuntime {
  const home = path.join(root, "runtime-home");
  const provider = path.join(root, "provider");
  const profile = path.join(home, ".pi", "agent", "pi-cliproxyapi");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(provider);
  fs.writeFileSync(
    path.join(provider, "package.json"),
    JSON.stringify({ name: "pi-cliproxyapi", version: "0.4.3" }),
  );
  fs.writeFileSync(path.join(provider, "index.ts"), "export default {};\n");
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      proxy: {
        endpoint: "http://proxy.invalid/v1",
        apiKey: "$PIPELINE_MODEL_KEY",
      },
      builtinProviders: { openai: { enabled: true, models: [MODEL_ID] } },
    }),
  );
  const model = {
    id: MODEL_ID,
    name: MODEL_ID,
    reasoning: true,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  fs.writeFileSync(
    path.join(profile, "discovery-cache.json"),
    JSON.stringify({
      savedAt: 0,
      discovery: {
        source: "v1-models",
        upstreamVersion: null,
        builtinProviders: [
          { name: "openai", api: "openai-responses", models: [model] },
        ],
        customPool: [],
        serverDiscoveryExcludes: [],
        upstreamTotal: 1,
      },
    }),
  );
  return {
    home,
    providerExtension: path.join(provider, "index.ts"),
    credentialEnv: ["PIPELINE_MODEL_KEY"],
    modelContextWindows: { [MODEL]: CONTEXT_WINDOW },
  };
}

// The `kind` records (`<!-- agent-pipeline:KIND` comments) on issue ISSUE
// in `world`, parsed, oldest first.
function marked(world: World, kind: string): z.infer<typeof RECORD>[] {
  const mark = `<!-- agent-pipeline:${kind}\n`;
  const issue = world.issues.find((item) => item.number === ISSUE);
  return (issue?.comments ?? []).flatMap((comment) => {
    const start = comment.body.indexOf(mark);
    if (start === -1) {
      return [];
    }
    const [json = ""] = comment.body.slice(start + mark.length).split("\n-->");
    return [RECORD.parse(JSON.parse(json))];
  });
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function actionsOf(pipeline: string): ActionRun[] {
  const dir = path.join(pipeline, "runs", SLUG, `issue-${ISSUE}`, "actions");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .map((id) => ACTION_RUN.parse(readJson(path.join(dir, id, "run.json"))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The access profile each task the flow buddies run needs (its TASKS
// definition's `access`).
const ACCESS: Readonly<Record<BuddyChoice["tasks"][number], string>> = {
  implement: "writer",
  harden: "writer",
  integrate: "reader",
  "review-security": "reader",
  land: "lander",
  complete: "lander",
};

// Writes `file`, the trusted file of `buddy`, scoped to `repositoryConfig`
// in ORGANIZATION.
function writeBuddyConfig(
  file: string,
  repositoryConfig: string,
  buddy: BuddyChoice,
): void {
  const tasks: BuddyChoice["tasks"][number][] = buddy.tasks;
  const profiles = [...new Set(tasks.map((task) => ACCESS[task]))];
  let name = "hippy";
  let login = DEVELOPER;
  let permissions = {};
  if (buddy.role === "gatekeeper") {
    name = "lawd";
    login = LANDING;
    if (buddy.tasks.includes("land")) {
      permissions = { permissions: { land: true } };
    }
  }
  writePrivate(file, {
    version: 1,
    name,
    scope: { organization: ORGANIZATION, repositories: [repositoryConfig] },
    role: buddy.role,
    responsibilities: buddy.tasks,
    identity: { name, account: { provider: "github", login }, profiles },
    ...permissions,
    pollSeconds: 5,
    stopPollSeconds: 1,
  });
}

// The repository config's lane slot pool, when the machine has one.
function laneSlotsOf(setup: MachineSetup): { laneSlots?: number } {
  if (setup.laneSlots === undefined) {
    return {};
  }
  return { laneSlots: setup.laneSlots };
}

// A machine whose buddies work on REPO in ORGANIZATION. Its own trusted
// buddy file, buddy.json, is the Developer hippy's, responsible for
// Implement. `edit` adjusts the initial world; `setup` fixes the trusted
// repository configuration.
function machine(
  edit: (world: World) => void = () => undefined,
  setup: MachineSetup = { landPermission: false },
): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-flow-"));
  const pipeline = path.join(root, "pipeline");
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  for (const dir of [pipeline, agentDir, home, bin]) {
    fs.mkdirSync(dir);
  }
  install(pipeline, agentDir);
  writeShim(bin, "gh", FAKE_GH);
  writeShim(bin, "pi", FAKE_PI);
  const { origin, work, policy, revision } = repository(root, setup.setup);
  const credentials = path.join(root, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
  );
  fs.chmodSync(credentials, PRIVATE);
  const repositoryConfig = path.join(root, "repo.json");
  writePrivate(repositoryConfig, {
    repo: REPO,
    baseBranch: "main",
    cloneUrl: origin,
    devAccount: DEVELOPER,
    landingAccount: LANDING,
    credentialsEnvFile: credentials,
    allowedUsers: [HUMAN],
    permissions: { land: setup.landPermission },
    ...laneSlotsOf(setup),
    models: { author: MODEL, developer: MODEL, reviewer: MODEL },
    runtime: provisionRuntime(root),
    projectPolicy: { repository: policy, revision },
  });
  const buddyFile = path.join(root, "buddy.json");
  writeBuddyConfig(buddyFile, repositoryConfig, {
    role: "developer",
    tasks: ["implement"],
  });
  const worldFile = path.join(root, "world.json");
  const ghLog = path.join(root, "gh.log");
  const piLog = path.join(root, "pi.log");
  const commitLog = path.join(root, "commits.log");
  const plan = path.join(root, "pi-plan.json");
  fs.writeFileSync(ghLog, "");
  fs.writeFileSync(piLog, "");
  fs.writeFileSync(commitLog, "");
  const initial = baseWorld();
  initial.issues.push(startedIssue());
  initial.collaborators = [HUMAN];
  initial.pulls = [];
  edit(initial);
  writeWorld(worldFile, initial);
  const { PATH: inherited = "" } = process.env;
  const env = {
    ...process.env,
    ...Object.fromEntries([
      ["PATH", `${bin}${path.delimiter}${inherited}`],
      ["HOME", home],
      ["ISSUE_PIPELINE_ROOT", pipeline],
      ["PI_CODING_AGENT_DIR", agentDir],
      ["FAKE_GH_WORLD", worldFile],
      ["FAKE_GH_LOG", ghLog],
      ["FAKE_GH_ORIGIN", origin],
      ["FAKE_PI_PLAN", plan],
      ["FAKE_PI_LOG", piLog],
      ["FAKE_PI_COMMITS", commitLog],
      ["PIPELINE_MODEL_KEY", "fake-model-key"],
    ]),
  };
  function change(apply: (world: World) => void): void {
    const current = readWorld(worldFile);
    apply(current);
    writeWorld(worldFile, current);
  }
  async function runBuddy(
    sessions: PlannedSession[],
    stopAtPoll: number,
    buddy?: BuddyChoice,
  ): Promise<BuddyOutcome> {
    let buddyConfig = buddyFile;
    if (buddy !== undefined) {
      buddyConfig = path.join(
        root,
        `buddy-${buddy.role}-${buddy.tasks.join("-")}.json`,
      );
      writeBuddyConfig(buddyConfig, repositoryConfig, buddy);
    }
    fs.writeFileSync(plan, JSON.stringify({ next: 0, sessions }));
    const child = spawn(
      process.execPath,
      [path.join(pipeline, "buddy.mjs"), "--config", buddyConfig],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (child.pid === undefined) {
      throw new Error("the buddy did not start");
    }
    const { pid } = child;
    change((world) => {
      world.stopBuddy = { pid, atPoll: stopAtPoll, polls: 0 };
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // A buddy the fake gh never stopped gets the same graceful SIGTERM,
    // by its own pid, once the run overstays.
    const overstay = setTimeout(() => {
      child.kill("SIGTERM");
    }, OVERSTAY_MS);
    const status = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    clearTimeout(overstay);
    let ended: z.infer<typeof ENDED>;
    try {
      ended = ENDED.parse(JSON.parse(stdout));
    } catch (error: unknown) {
      throw new Error(`buddy exited ${String(status)}: ${stdout}\n${stderr}`, {
        cause: error,
      });
    }
    const run = BUDDY_RUN_OBSERVATION.parse(
      readJson(
        path.join(pipeline, "runs", "buddy-runs", ended.buddyRun, "run.json"),
      ),
    );
    return { status, stderr, ended, run, actions: actionsOf(pipeline) };
  }
  return {
    root,
    origin,
    work,
    pipeline,
    world: () => readWorld(worldFile),
    change,
    calls: () =>
      fs
        .readFileSync(ghLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => LOGGED.parse(JSON.parse(line))),
    commits: () =>
      fs
        .readFileSync(commitLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => COMMIT_RESULT.parse(JSON.parse(line))),
    launches: () =>
      fs
        .readFileSync(piLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => PI_LAUNCH.parse(JSON.parse(line))),
    runBuddy,
    git: (args: string[]) => git(origin, args),
    checksRun: (): string[] => {
      if (!fs.existsSync(checksLog(root))) {
        return [];
      }
      return fs
        .readFileSync(checksLog(root), "utf8")
        .split("\n")
        .filter((line) => line !== "");
    },
    readGitHub: (args: string[]): unknown => {
      const read = spawnSync(process.execPath, [FAKE_GH, ...args], {
        encoding: "utf8",
        env: { ...env, ...Object.fromEntries([["GH_TOKEN", "landing-token"]]) },
      });
      if (read.status !== 0) {
        throw new Error(`gh ${args.join(" ")}: ${read.stderr}`);
      }
      const parsed: unknown = JSON.parse(read.stdout);
      return parsed;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export type {
  ActionRun,
  BuddyChoice,
  BuddyOutcome,
  Machine,
  MachineSetup,
  PlannedSession,
};
export { DEVELOPER, HUMAN, ISSUE, machine, marked };
