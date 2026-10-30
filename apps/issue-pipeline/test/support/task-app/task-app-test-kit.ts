// The task app tests' kit: a temporary machine with fake GitHub
// (fake-github-test-kit.ts), one repository config, a private credential
// file with each buddy's token, a buddy file for each of two buddies with
// their own accounts, and a task app, by default the sample task app
// (sample-task-app.ts), run in a fresh process as a buddy runs it.
// Issue ISSUE starts with `start:gherkin`
// applied by a person. Tests change the world as GitHub or a person would,
// hold a run live at its gate, and read back what a person sees. The
// launcher's tests install the sample app as other tasks' apps in the
// pipeline root and run the buddy itself (src/buddy.ts), as the operator
// runs it, reading each app's exit from the buddy's log.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { startFakeGitHub } from "../signals/fake-github-test-kit.ts";
import {
  type FakeComment,
  readWorld,
  type World,
  writeWorld,
} from "../signals/fake-github-world.ts";

const { PATH: searchPath }: NodeJS.ProcessEnv = process.env;
const SAMPLE = path.join(import.meta.dirname, "sample-task-app.ts");
const BUDDY = path.resolve(import.meta.dirname, "../../../dist/launcher.mjs");
const REPO = "acme/widgets";
const ISSUE = 7;
const PERSON = "autumn";
const BUDDIES = { hippy: "hippy-dev", lawd: "lawd-landing" } as const;
const PRIVATE = 0o600;
// Deadlines that only fail a test; nothing waits for them to pass.
const GATE_DEADLINE_MS = 60_000;
const EXIT_DEADLINE_MS = 120_000;
const FIRST_EVENT = 100;
const MARKER =
  /<!-- task-app:(?<task>[a-z-]+):(?<kind>[a-z-]+) (?<payload>\{.*?\}) -->/u;
const TOKENS = { hippy: "dev-token", lawd: "landing-token" } as const;
const VARIABLES = {
  hippy: "HIPPY_GITHUB_TOKEN",
  lawd: "LAWD_GITHUB_TOKEN",
} as const;
// The buddy's log line for one task app's end.
const APP_EXIT = z.looseObject({
  task: z.string(),
  issue: z.string(),
  exit: z.number().int().nullable(),
  signal: z.string().nullable(),
});
const NEWLINE = /\r?\n/u;

type Buddy = keyof typeof BUDDIES;
interface Ended {
  status: number | null;
  stderr: string;
}
// One run of the sample task app.
interface AppRun {
  // Waits until the run's work reaches its gate.
  ready: () => void;
  // Lets the run's work go on past its gate.
  release: () => void;
  // Ends the run's process at once, as a crash would.
  kill: () => void;
  exited: Promise<Ended>;
}
interface RunOptions {
  gate?: boolean;
  fail?: string;
}
type AppExit = z.infer<typeof APP_EXIT>;
interface BuddyEnded {
  status: number | null;
  stdout: string;
  stderr: string;
}
// A gate the sample app's work waits at, which any number of runs share.
interface Gate {
  path: string;
  // Waits until one more run reaches the gate.
  ready: () => void;
  // Lets every run waiting at the gate go on.
  release: () => void;
}
// One run of a launcher buddy.
interface BuddyRun {
  // Resolves with the first exit the buddy logs that `matches`, counting
  // exits it logged already.
  exit: (matches: (exit: AppExit) => boolean) => Promise<AppExit>;
  // Every app exit the buddy has logged so far.
  exits: () => AppExit[];
  // Stops the buddy with SIGTERM and resolves once it has exited.
  stop: () => Promise<BuddyEnded>;
  exited: Promise<BuddyEnded>;
}
// What a launcher buddy file names beyond its account.
interface LauncherOptions {
  tasks: string[];
  gate?: Gate;
  fail?: string;
}
interface Machine {
  root: string;
  // The folder holding the machine's `gh`, and its pipeline root.
  bin: string;
  pipeline: string;
  world: () => World;
  change: (edit: (world: World) => void) => void;
  // Starts the machine's task app as `buddy`.
  run: (buddy: Buddy, options?: RunOptions) => AppRun;
  // Runs the machine's task app as `buddy` to its end.
  runToEnd: (buddy: Buddy, options?: RunOptions) => Promise<Ended>;
  // Writes `buddy`'s file with `tasks` and returns its path.
  buddyFile: (buddy: Buddy, tasks?: string[]) => string;
  // Installs the sample task app as `task`'s app in the pipeline root.
  install: (task: string) => void;
  // Runs `buddy --check` on `buddy`'s file with `tasks`, to its end.
  check: (buddy: Buddy, tasks: string[]) => BuddyEnded;
  // A new gate for the apps of launcher buddies.
  gate: () => Gate;
  // Starts `buddy` as a launcher of `options.tasks`.
  launch: (buddy: Buddy, options: LauncherOptions) => BuddyRun;
  cleanup: () => void;
}

function baseWorld(): World {
  return {
    repo: REPO,
    organization: "acme",
    organizationObject: false,
    tokens: [
      { token: "dev-token", login: BUDDIES.hippy },
      { token: "landing-token", login: BUDDIES.lawd },
    ],
    accounts: [
      { login: BUDDIES.hippy, id: 1, type: "User" },
      { login: BUDDIES.lawd, id: 2, type: "User" },
      { login: PERSON, id: 10, type: "User" },
    ],
    members: [],
    issues: [
      {
        number: ISSUE,
        title: "Sample work",
        body: "Do the sample work.",
        author: PERSON,
        pullRequest: false,
        labels: ["start:gherkin"],
        events: [
          {
            id: FIRST_EVENT,
            event: "labeled",
            label: "start:gherkin",
            actor: PERSON,
            viaApp: false,
            createdAt: "2026-10-25T11:00:00Z",
          },
        ],
        comments: [],
      },
    ],
    faults: [],
    pageSize: 100,
    post: "ok",
    nextId: 500,
  };
}

function writePrivate(file: string, text: string): void {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, PRIVATE);
}

function fifo(file: string): void {
  const made = spawnSync("mkfifo", [file]);
  if (made.status !== 0) {
    throw new Error(`mkfifo failed: ${String(made.stderr)}`);
  }
}

// Waits until the run at `gate` writes that its work reached the gate.
function awaitGate(gate: string, stderr: string): void {
  const read = spawnSync("cat", [`${gate}.ready`], {
    encoding: "utf8",
    timeout: GATE_DEADLINE_MS,
  });
  if (read.stdout !== "ready\n") {
    throw new Error(`the run never reached its gate: ${stderr}`);
  }
}

// Lets the run held at `gate` go on.
function openGate(gate: string, stderr: string): void {
  const wrote = spawnSync("sh", ["-c", 'printf go > "$1"', "sh", gate], {
    timeout: GATE_DEADLINE_MS,
  });
  if (wrote.status !== 0) {
    throw new Error(`the run's gate could not be opened: ${stderr}`);
  }
}

// A person applies `label` to the issue, as GitHub records it.
function apply(world: World, label: string, by: string = PERSON): void {
  const issue = world.issues.find((item) => item.number === ISSUE);
  if (issue === undefined || issue.labels.includes(label)) {
    return;
  }
  issue.labels.push(label);
  issue.events.push({
    id: world.nextId,
    event: "labeled",
    label,
    actor: by,
    viaApp: false,
    createdAt: new Date().toISOString(),
  });
  world.nextId += 1;
}

// A person removes `label` from the issue, as GitHub records it.
function remove(world: World, label: string, by: string = PERSON): void {
  const issue = world.issues.find((item) => item.number === ISSUE);
  if (issue === undefined || !issue.labels.includes(label)) {
    return;
  }
  issue.labels = issue.labels.filter((present) => present !== label);
  issue.events.push({
    id: world.nextId,
    event: "unlabeled",
    label,
    actor: by,
    viaApp: false,
    createdAt: new Date().toISOString(),
  });
  world.nextId += 1;
}

function originEnv(origin: string | undefined): Record<string, string> {
  if (origin === undefined) {
    return {};
  }
  return Object.fromEntries([["FAKE_GH_ORIGIN", origin]]);
}

function issueOf(world: World): World["issues"][number] {
  const issue = world.issues.find((item) => item.number === ISSUE);
  if (issue === undefined) {
    throw new Error(`the world has no issue #${ISSUE}`);
  }
  return issue;
}

// `task`'s marked comments of `kind` on the issue.
function marked(world: World, kind: string, task = "gherkin"): FakeComment[] {
  return issueOf(world).comments.filter((comment) => {
    const { task: by, kind: found } = MARKER.exec(comment.body)?.groups ?? {};
    return by === task && found === kind;
  });
}

function appExits(stderr: string): AppExit[] {
  return stderr.split(NEWLINE).flatMap((line): AppExit[] => {
    if (!line.startsWith("{")) {
      return [];
    }
    const parsed = APP_EXIT.safeParse(JSON.parse(line));
    if (!parsed.success) {
      return [];
    }
    return [parsed.data];
  });
}

// A machine whose world `setup` changes first. With `origin`, a local bare
// repository, fake GitHub serves that repository's Git database. `app` is
// the task app's program, the sample task app unless given.
function machine(
  setup: (world: World) => void = (): void => undefined,
  served: {
    origin?: string;
    app?: string;
    task?: string;
    environment?: ReadonlyMap<string, string>;
  } = {},
): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-task-app-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const pipeline = path.join(root, "pipeline");
  fs.mkdirSync(pipeline);
  const worldFile = path.join(root, "world.json");
  const world = baseWorld();
  setup(world);
  writeWorld(worldFile, world);
  const github = startFakeGitHub({
    root,
    bin,
    world: worldFile,
    log: path.join(root, "gh.log"),
    env: { ...process.env, ...originEnv(served.origin) },
  });
  const credentials = path.join(root, "credentials.env");
  writePrivate(
    credentials,
    `${VARIABLES.hippy}=${TOKENS.hippy}\n${VARIABLES.lawd}=${TOKENS.lawd}\n`,
  );
  const repository = path.join(root, "repo.json");
  writePrivate(repository, JSON.stringify({ repo: REPO, baseBranch: "main" }));
  const children: ChildProcess[] = [];
  let runs = 0;
  // A task app reads only the account and scope; a launcher also its tasks.
  function buddyFile(buddy: Buddy, tasks: string[] = ["gherkin"]): string {
    const file = path.join(root, `${buddy}.json`);
    writePrivate(
      file,
      JSON.stringify({
        version: 2,
        name: buddy,
        scope: { repositories: [repository] },
        tasks,
        account: {
          login: BUDDIES[buddy],
          credentials: { file: credentials, variable: VARIABLES[buddy] },
        },
        pollSeconds: 1,
        claimWaitsMs: [1, 1, 1],
      }),
    );
    return file;
  }
  const registrations = new Map<string, string>();
  function install(task: string): void {
    registrations.set(task, `${task}.mjs`);
    fs.writeFileSync(
      path.join(pipeline, "tasks.json"),
      JSON.stringify({
        version: 1,
        tasks: [...registrations].map(([id, executable]) => ({
          id,
          executable,
        })),
      }),
    );
    fs.writeFileSync(
      path.join(pipeline, `${task}.mjs`),
      `process.env.SAMPLE_TASK_ID = ${JSON.stringify(task)};\nawait import(${JSON.stringify(pathToFileURL(SAMPLE).href)});\n`,
    );
  }
  function gateOf(gated: boolean | undefined): string {
    if (gated !== true) {
      return "";
    }
    runs += 1;
    const file = path.join(root, `gate-${runs}`);
    fifo(file);
    fifo(`${file}.ready`);
    return file;
  }
  function appEnv(gated: string, fail: string | undefined): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...Object.fromEntries(served.environment ?? []),
      ...Object.fromEntries([
        ["PATH", `${bin}:${searchPath ?? ""}`],
        ["ISSUE_PIPELINE_ROOT", pipeline],
        ["SAMPLE_TASK_GATE", gated],
        ["SAMPLE_TASK_FAIL", fail ?? ""],
        ["SAMPLE_TASK_ID", ""],
      ]),
    };
  }
  function start(buddy: Buddy, options: RunOptions = {}): AppRun {
    const held = gateOf(options.gate);
    const child = spawn(
      process.execPath,
      [
        served.app ?? SAMPLE,
        "--config",
        buddyFile(buddy, [served.task ?? "gherkin"]),
        "--issue",
        `${REPO}#${ISSUE}`,
      ],
      {
        env: appEnv(held, options.fail),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<Ended>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the task app did not exit: ${stderr}`));
      }, EXIT_DEADLINE_MS);
      child.once("close", (status) => {
        clearTimeout(deadline);
        resolve({ status, stderr });
      });
    });
    return {
      ready: (): void => {
        awaitGate(held, stderr);
      },
      release: (): void => {
        openGate(held, stderr);
      },
      kill: (): void => {
        child.kill("SIGKILL");
      },
      exited,
    };
  }
  function checkBuddy(buddy: Buddy, tasks: string[]): BuddyEnded {
    const result = spawnSync(
      process.execPath,
      [BUDDY, "--config", buddyFile(buddy, tasks), "--check"],
      { env: appEnv("", ""), encoding: "utf8", timeout: EXIT_DEADLINE_MS },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  function newGate(): Gate {
    const file = gateOf(true);
    return {
      path: file,
      ready: (): void => {
        awaitGate(file, "");
      },
      release: (): void => {
        openGate(file, "");
      },
    };
  }
  function launch(buddy: Buddy, options: LauncherOptions): BuddyRun {
    const child = spawn(
      process.execPath,
      [BUDDY, "--config", buddyFile(buddy, options.tasks)],
      {
        env: appEnv(options.gate?.path ?? "", options.fail),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    const waiting: (() => void)[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      for (const check of [...waiting]) {
        check();
      }
    });
    const exited = new Promise<BuddyEnded>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`the buddy did not exit: ${stderr}`));
      }, EXIT_DEADLINE_MS);
      child.once("close", (status) => {
        clearTimeout(deadline);
        resolve({ status, stdout, stderr });
        for (const check of [...waiting]) {
          check();
        }
      });
    });
    return {
      exit: (matches: (exit: AppExit) => boolean): Promise<AppExit> =>
        new Promise<AppExit>((resolve, reject) => {
          const deadline = setTimeout(() => {
            settle();
            reject(new Error(`the buddy never logged that exit: ${stderr}`));
          }, EXIT_DEADLINE_MS);
          function settle(): void {
            clearTimeout(deadline);
            waiting.splice(waiting.indexOf(check), 1);
          }
          function check(): void {
            const found = appExits(stderr).find(matches);
            if (found !== undefined) {
              settle();
              resolve(found);
            } else if (child.exitCode !== null || child.signalCode !== null) {
              settle();
              reject(new Error(`the buddy exited first: ${stderr}`));
            }
          }
          waiting.push(check);
          check();
        }),
      exits: (): AppExit[] => appExits(stderr),
      stop: (): Promise<BuddyEnded> => {
        child.kill("SIGTERM");
        return exited;
      },
      exited,
    };
  }
  return {
    root,
    bin,
    pipeline,
    world: (): World => readWorld(worldFile),
    change: github.change,
    buddyFile,
    install,
    check: checkBuddy,
    gate: newGate,
    launch,
    run: start,
    runToEnd: (buddy: Buddy, options: RunOptions = {}): Promise<Ended> =>
      start(buddy, options).exited,
    cleanup: (): void => {
      for (const child of children) {
        child.kill("SIGKILL");
      }
      github.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export type {
  AppExit,
  AppRun,
  Buddy,
  BuddyEnded,
  BuddyRun,
  Ended,
  Gate,
  Machine,
};
export {
  apply,
  BUDDIES,
  ISSUE,
  issueOf,
  machine,
  marked,
  PERSON,
  REPO,
  remove,
};
