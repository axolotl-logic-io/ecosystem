// The task app tests' kit: a temporary machine with fake GitHub
// (fake-github-test-kit.ts), one repository config with a private
// credential file, a buddy file for each of two buddies with their own
// accounts, and the sample task app (sample-task-app.ts) run in a fresh
// process as a buddy runs it. Issue ISSUE starts with `start:sample`
// applied by a person. Tests change the world as GitHub or a person would,
// hold a run live at its gate, and read back what a person sees.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startFakeGitHub } from "../signals/fake-github-test-kit.ts";
import {
  type FakeComment,
  readWorld,
  type World,
  writeWorld,
} from "../signals/fake-github-world.ts";

const { PATH: searchPath }: NodeJS.ProcessEnv = process.env;
const SAMPLE = path.join(import.meta.dirname, "sample-task-app.ts");
const REPO = "acme/widgets";
const ISSUE = 7;
const PERSON = "autumn";
const BUDDIES = { hippy: "hippy-dev", lawd: "lawd-landing" } as const;
const PRIVATE = 0o600;
// Deadlines that only fail a test; nothing waits for them to pass.
const GATE_DEADLINE_MS = 60_000;
const EXIT_DEADLINE_MS = 120_000;
const FIRST_EVENT = 100;
const MARKER = /<!-- task-app:sample:(?<kind>[a-z-]+) (?<payload>\{.*?\}) -->/u;

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
interface Machine {
  root: string;
  // The folder holding the machine's `gh`, and its pipeline root.
  bin: string;
  pipeline: string;
  world: () => World;
  change: (edit: (world: World) => void) => void;
  // Starts the sample task app as `buddy`.
  run: (buddy: Buddy, options?: RunOptions) => AppRun;
  // Runs the sample task app as `buddy` to its end.
  runToEnd: (buddy: Buddy, options?: RunOptions) => Promise<Ended>;
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
        labels: ["start:sample"],
        events: [
          {
            id: FIRST_EVENT,
            event: "labeled",
            label: "start:sample",
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
    tasks: [],
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

// The sample task's marked comments of `kind` on the issue.
function marked(world: World, kind: string): FakeComment[] {
  return issueOf(world).comments.filter((comment) => {
    const { kind: found } = MARKER.exec(comment.body)?.groups ?? {};
    return found === kind;
  });
}

// A machine whose world `setup` changes first. With `origin`, a local bare
// repository, fake GitHub serves that repository's Git database.
function machine(
  setup: (world: World) => void = (): void => undefined,
  served: { origin?: string } = {},
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
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
  );
  const repository = path.join(root, "repo.json");
  writePrivate(
    repository,
    JSON.stringify({
      repo: REPO,
      baseBranch: "main",
      devAccount: BUDDIES.hippy,
      landingAccount: BUDDIES.lawd,
      credentialsEnvFile: credentials,
    }),
  );
  function buddyFile(buddy: Buddy): string {
    const file = path.join(root, `${buddy}.json`);
    writePrivate(
      file,
      JSON.stringify({
        version: 1,
        name: buddy,
        scope: { organization: "acme", repositories: [repository] },
        identity: { account: { provider: "github", login: BUDDIES[buddy] } },
        claimWaitsMs: [1, 1, 1],
      }),
    );
    return file;
  }
  const children: ChildProcess[] = [];
  let runs = 0;
  function start(buddy: Buddy, options: RunOptions = {}): AppRun {
    runs += 1;
    let gate = "";
    if (options.gate === true) {
      gate = path.join(root, `gate-${runs}`);
      fifo(gate);
      fifo(`${gate}.ready`);
    }
    const child = spawn(
      process.execPath,
      [SAMPLE, "--config", buddyFile(buddy), "--issue", `${REPO}#${ISSUE}`],
      {
        env: {
          ...process.env,
          ...Object.fromEntries([
            ["PATH", `${bin}:${searchPath ?? ""}`],
            ["ISSUE_PIPELINE_ROOT", pipeline],
            ["SAMPLE_TASK_GATE", gate],
            ["SAMPLE_TASK_FAIL", options.fail ?? ""],
          ]),
        },
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
        const read = spawnSync("cat", [`${gate}.ready`], {
          encoding: "utf8",
          timeout: GATE_DEADLINE_MS,
        });
        if (read.stdout !== "ready\n") {
          throw new Error(`the run never reached its gate: ${stderr}`);
        }
      },
      release: (): void => {
        const wrote = spawnSync("sh", ["-c", 'printf go > "$1"', "sh", gate], {
          timeout: GATE_DEADLINE_MS,
        });
        if (wrote.status !== 0) {
          throw new Error(`the run's gate could not be opened: ${stderr}`);
        }
      },
      kill: (): void => {
        child.kill("SIGKILL");
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

export type { AppRun, Buddy, Ended, Machine };
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
