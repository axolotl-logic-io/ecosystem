// Disposable task-app machine: real Git, fake GitHub and fake model sessions.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { PolicyPin } from "../../support/project-policy-test-kit.ts";
import { committedPolicy } from "../../support/project-policy-test-kit.ts";
import { startFakeGitHub } from "../../support/signals/fake-github-test-kit.ts";
import type {
  FakeIssue,
  World,
} from "../../support/signals/fake-github-world.ts";
import {
  readWorld,
  writeWorld,
} from "../../support/signals/fake-github-world.ts";
import {
  baseWorld,
  LANDING,
  REPO,
} from "../../support/signals/signal-test-kit.ts";

const SOURCE = path.resolve(import.meta.dirname, "../../..");
const FAKE_PI = path.join(import.meta.dirname, "fake-pi.ts");
const DEVELOPER = "lawd-dev";
const HUMAN = "autumn";
const EXECUTABLE = 0o755;
const PRIVATE = 0o600;
const ISSUE = 7;
const MODEL_ID = "fake-model";
const CONTEXT_WINDOW = 272_000;
const API_OF = {
  openai: "openai-responses",
  anthropic: "anthropic-messages",
} as const;
const OVERSTAY_MS = 140_000;
// How long `when` waits for its condition, unless told otherwise, before
// failing the test.
const WHEN_MS = 30_000;
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
    | "comments-unreadable"
    | "rival-push"
    | "reapply-implement-start"
    | "apply-verify-start"
    | null;
  // Whether `change` comes before the commit rather than after it.
  changeFirst: boolean;
  // A file left written and uncommitted in the code checkout.
  strayWrite?: { file: string; content: string };
  // A conflicted file the session resolves to `content` and stages, as a
  // Fix session does before its merge concludes.
  resolve?: { file: string; content: string };
  awaitAbort: boolean;
  reply: Record<string, unknown> | null;
}

// Implement's fresh hardening session, for a test that doesn't look into
// it: it finds nothing to change and commits nothing.
const HARDENING: PlannedSession = {
  commit: null,
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Hardened: nothing to change." },
};

// Account and task responsibilities are independent selections.
interface BuddyChoice {
  account: "hippy" | "lawd";
  tasks: string[];
}

// The machine's trusted repository configuration, fixed before any action:
// whether it grants Land (`permissions.land`), which the shared checking
// policy digest covers, its optional lane slot pool (`laneSlots`) and the
// pinned project policy's optional setup, teardown and test commands; the
// test command otherwise logs the commit it checked (checksRun).
interface MachineSetup {
  landPermission: boolean;
  laneSlots?: number;
  // Operator CI policy; absence keeps the production default.
  requireCi?: boolean;
  setup?: string;
  teardown?: string;
  test?: string;
  // The builtin provider CLIProxy serves the models through; openai when
  // absent.
  provider?: "openai" | "anthropic";
}

interface TaskAppRun {
  exited: Promise<TaskAppEnd>;
  kill: () => void;
}

// How a task app's process ended, and what it wrote to stderr.
interface TaskAppEnd {
  status: number | null;
  stderr: string;
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
  // Runs task app `app` (APP.mjs) once on issue ISSUE as `buddy`, from a
  // trusted file of its own, with `sessions` planned, to its end.
  startTaskApp: (
    app: string,
    sessions: PlannedSession[],
    buddy?: BuddyChoice,
  ) => TaskAppRun;
  runTaskApp: (
    app: string,
    buddy: BuddyChoice,
    sessions: PlannedSession[],
  ) => Promise<TaskAppEnd>;
  git: (args: string[]) => string;
  // The commits the project's check ran on, in order.
  checksRun: () => string[];
  // What GitHub answers the landing account's `gh args`, as a person
  // reading it would see; the call is logged like any other.
  readGitHub: (args: string[]) => unknown;
  // Resolves once `ready` holds, rechecked whenever a file directly in
  // `root` changes, such as the gh, pi or commands log; rejects when
  // `signal` aborts or after `withinMs` (WHEN_MS by default).
  when: (ready: () => boolean, options?: WhenOptions) => Promise<void>;
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

// A `name` on PATH that runs `script` with this Node, caching its compiled
// code in `cache`.
function writeShim(
  bin: string,
  name: string,
  script: string,
  cache: string,
): void {
  const shim = path.join(bin, name);
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nNODE_COMPILE_CACHE="${cache}" exec "${process.execPath}" "${script}" "$@"\n`,
  );
  fs.chmodSync(shim, EXECUTABLE);
}

interface WhenOptions {
  signal?: AbortSignal;
  withinMs?: number;
}

function when(
  dir: string,
  ready: () => boolean,
  options: WhenOptions,
): Promise<void> {
  const { signal, withinMs = WHEN_MS } = options;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      settle(new Error(`the awaited condition never held in ${withinMs} ms`));
    }, withinMs);
    const watcher = fs.watch(dir, check);
    function abort(): void {
      settle(signal?.reason);
    }
    function settle(error: unknown): void {
      clearTimeout(deadline);
      watcher.close();
      signal?.removeEventListener("abort", abort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    }
    function check(): void {
      if (ready()) {
        settle(undefined);
      }
    }
    watcher.on("error", settle);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    } else {
      check();
    }
  });
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
  configured: Pick<MachineSetup, "setup" | "teardown" | "test">,
): {
  origin: string;
  work: string;
  projectPolicy: PolicyPin;
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
  const { setup, teardown } = configured;
  const test = configured.test ?? `git rev-parse HEAD >> '${checksLog(root)}'`;
  const commands: { test: string; setup?: string; teardown?: string } = {
    test,
  };
  if (setup !== undefined) {
    commands.setup = setup;
  }
  if (teardown !== undefined) {
    commands.teardown = teardown;
  }
  const projectPolicy = committedPolicy(policy, origin, {
    commands,
    resources: { modelSessions: 1 },
  });
  return { origin, work, projectPolicy };
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
function provisionRuntime(
  root: string,
  provider: "openai" | "anthropic",
): ProvisionedRuntime {
  const providerDir = path.join(root, "provider");
  const home = path.join(root, "runtime-home");
  const profile = path.join(home, ".pi", "agent", "pi-cliproxyapi");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(providerDir);
  fs.writeFileSync(
    path.join(providerDir, "package.json"),
    JSON.stringify({ name: "pi-cliproxyapi", version: "0.4.3" }),
  );
  fs.writeFileSync(path.join(providerDir, "index.ts"), "export default {};\n");
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      proxy: {
        endpoint: "http://proxy.invalid/v1",
        apiKey: "$PIPELINE_MODEL_KEY",
      },
      builtinProviders: { [provider]: { enabled: true, models: [MODEL_ID] } },
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
          { name: provider, api: API_OF[provider], models: [model] },
        ],
        customPool: [],
        serverDiscoveryExcludes: [],
        upstreamTotal: 1,
      },
    }),
  );
  return {
    home,
    providerExtension: path.join(providerDir, "index.ts"),
    credentialEnv: ["PIPELINE_MODEL_KEY"],
    modelContextWindows: { [`${provider}/${MODEL_ID}`]: CONTEXT_WINDOW },
  };
}

// The `kind` records (`<!-- agent-pipeline:KIND` comments) on issue ISSUE
// in `world`, parsed, oldest first.
function marked(
  world: World,
  kind: string,
  number = ISSUE,
): z.infer<typeof RECORD>[] {
  const mark = `<!-- agent-pipeline:${kind}\n`;
  const issue = world.issues.find((item) => item.number === number);
  return (issue?.comments ?? []).flatMap((comment) => {
    const start = comment.body.indexOf(mark);
    if (start === -1) {
      return [];
    }
    const [json = ""] = comment.body.slice(start + mark.length).split("\n-->");
    return [RECORD.parse(JSON.parse(json))];
  });
}

// Writes a trusted version 2 launcher buddy file with explicit tasks,
// repository scope and its account token in `credentials`.
function writeLauncherBuddy(
  file: string,
  setup: { repositoryConfig: string; credentials: string },
  buddy: BuddyChoice,
): void {
  let name = "hippy";
  let login = DEVELOPER;
  let variable = "ISSUE_PIPELINE_DEV_GITHUB_TOKEN";
  if (buddy.account === "lawd") {
    name = "lawd";
    login = LANDING;
    variable = "ISSUE_PIPELINE_LANDING_GITHUB_TOKEN";
  }
  writePrivate(file, {
    version: 2,
    name,
    scope: { repositories: [setup.repositoryConfig] },
    tasks: buddy.tasks,
    account: { login, credentials: { file: setup.credentials, variable } },
    pollSeconds: 1,
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
  const compileCache = path.join(root, "compile-cache");
  writeShim(bin, "pi", FAKE_PI, compileCache);
  const { origin, work, projectPolicy } = repository(root, setup);
  const provider = setup.provider ?? "openai";
  const model = `${provider}/${MODEL_ID}`;
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
    requireCi: setup.requireCi,
    ...laneSlotsOf(setup),
    models: { gherkin: model, developer: model, reviewer: model },
    runtime: provisionRuntime(root, provider),
    projectPolicy,
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
      ["FAKE_GH_SOCKET", path.join(root, "gh.sock")],
      ["FAKE_PI_PLAN", plan],
      ["FAKE_PI_LOG", piLog],
      ["FAKE_PI_COMMITS", commitLog],
      ["PIPELINE_MODEL_KEY", "fake-model-key"],
    ]),
  };
  const github = startFakeGitHub({
    root,
    bin,
    world: worldFile,
    log: ghLog,
    env: {
      ...env,
      ...Object.fromEntries([["NODE_COMPILE_CACHE", compileCache]]),
    },
  });
  const { change } = github;
  function startTaskApp(
    app: string,
    sessions: PlannedSession[],
    buddy: BuddyChoice = { account: "hippy", tasks: ["implement"] },
  ): TaskAppRun {
    const buddyConfig = path.join(
      root,
      `launcher-${buddy.account}-${app}.json`,
    );
    writeLauncherBuddy(buddyConfig, { repositoryConfig, credentials }, buddy);
    fs.writeFileSync(plan, JSON.stringify({ next: 0, sessions }));
    const child = spawn(
      process.execPath,
      [
        path.join(pipeline, `${app}.mjs`),
        "--config",
        buddyConfig,
        "--issue",
        `${REPO}#${ISSUE}`,
      ],
      { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<TaskAppEnd>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${app} did not exit: ${stderr}`));
      }, OVERSTAY_MS);
      child.once("close", (status) => {
        clearTimeout(deadline);
        resolve({ status, stderr });
      });
    });
    return {
      exited,
      kill: (): void => {
        child.kill("SIGKILL");
      },
    };
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
    startTaskApp,
    runTaskApp: (
      app: string,
      buddy: BuddyChoice,
      sessions: PlannedSession[],
    ): Promise<TaskAppEnd> => startTaskApp(app, sessions, buddy).exited,
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
      const read = spawnSync(path.join(bin, "gh"), args, {
        encoding: "utf8",
        env: { ...env, ...Object.fromEntries([["GH_TOKEN", "landing-token"]]) },
      });
      if (read.status !== 0) {
        throw new Error(`gh ${args.join(" ")}: ${read.stderr}`);
      }
      const parsed: unknown = JSON.parse(read.stdout);
      return parsed;
    },
    when: (ready: () => boolean, options: WhenOptions = {}) =>
      when(root, ready, options),
    cleanup: (): void => {
      github.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// A person applies start label `label` to the issue now. A start label is
// the only thing that requests a task.
function applyStart(box: Pick<Machine, "change">, label: string): void {
  box.change((world) => {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    issue.labels = [...issue.labels.filter((name) => name !== label), label];
    issue.events = [
      ...issue.events,
      {
        id: world.nextId,
        event: "labeled",
        label,
        actor: HUMAN,
        viaApp: false,
        createdAt: "2026-10-26T10:00:00Z",
      },
    ];
    world.nextId += 1;
  });
}

export type {
  BuddyChoice,
  Machine,
  MachineSetup,
  PlannedSession,
  TaskAppEnd,
  TaskAppRun,
};
export { applyStart, DEVELOPER, HARDENING, HUMAN, ISSUE, machine, marked };
