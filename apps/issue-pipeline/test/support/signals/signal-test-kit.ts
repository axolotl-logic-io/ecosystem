// The signal tests' kit: a temporary pipeline root with a config, a private
// credential file, a world file, a local bare origin whose branches are the
// PR heads the fake gh reports, a `gh` on PATH answered by the fake GitHub
// server (fake-github-test-kit.ts), and a driver subprocess per inbox call.
// Tests change the world between calls as GitHub and the task lane would,
// then read back what the inbox returned, what it posted, which gh calls it
// made and what it journaled.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { committedPolicy } from "../project-policy-test-kit.ts";
import { startFakeGitHub } from "./fake-github-test-kit.ts";
import {
  type FakeIssue,
  type FakeReview,
  readWorld,
  type TaskAnswers,
  type World,
  writeWorld,
} from "./fake-github-world.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = "acme/widgets";
const ORGANIZATION = "acme";
const LANDING = "lawd-landing";
const BUDDY_RUN = "6f1c3c1e-8a63-4d47-9a37-0d6c8a0c5b11";
const SHA1_HEX = 40;
const SHA256_HEX = 64;
const COMMIT = "a".repeat(SHA1_HEX);
const REQUIREMENTS = `sha256:${"1".repeat(SHA256_HEX)}`;
const OTHER_REQUIREMENTS = `sha256:${"2".repeat(SHA256_HEX)}`;
const OTHER_COMMIT = "b".repeat(SHA1_HEX);
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
const MARK = "<!-- agent-pipeline:signal\n";
const MINUTES = 60;
const LOGGED = z.strictObject({ login: z.string(), args: z.array(z.string()) });

type FakePull = NonNullable<World["pulls"]>[number];

interface Harness {
  root: string;
  // Commits on issue `number`'s branch in the origin and returns the new
  // head.
  push: (number: number) => string;
  world: () => World;
  change: (edit: (world: World) => void) => void;
  poll: (organization?: string) => Inbox;
  requalify: (signal: unknown, organization?: string) => Verdict;
  requalifyNow: (source: unknown, organization?: string) => Verdict;
  latch: (number: number) => Verdict;
  latchNow: (number: number) => Verdict;
  calls: () => Logged[];
  posts: () => number;
  journal: (number: number) => string[];
}

const INBOX = z.strictObject({
  signals: z.array(
    z.looseObject({ kind: z.string(), id: z.string(), recordId: z.number() }),
  ),
  holds: z.array(
    z.strictObject({
      workItem: z
        .strictObject({ repo: z.string(), number: z.number() })
        .nullable(),
      reason: z.string(),
    }),
  ),
  complete: z.boolean(),
});
const VERDICT = z
  .looseObject({ reason: z.string() })
  .and(
    z.union([
      z.looseObject({ status: z.string() }),
      z.looseObject({ state: z.string() }),
    ]),
  );

type Inbox = z.infer<typeof INBOX>;
type Logged = z.infer<typeof LOGGED>;
type Verdict = z.infer<typeof VERDICT>;

function baseWorld(): World {
  return {
    repo: REPO,
    organization: ORGANIZATION,
    organizationObject: false,
    tokens: [
      { token: "landing-token", login: LANDING },
      { token: "dev-token", login: "lawd-dev" },
    ],
    accounts: [
      { login: LANDING, id: 1, type: "User" },
      { login: "lawd-dev", id: 2, type: "User" },
      { login: "autumn", id: 10, type: "User" },
      { login: "mallory", id: 11, type: "User" },
      { login: "renovate[bot]", id: 12, type: "Bot" },
      { login: "pending-pat", id: 13, type: "User" },
    ],
    members: [
      { login: LANDING, state: "active", role: "member" },
      { login: "lawd-dev", state: "active", role: "member" },
      { login: "autumn", state: "active", role: "admin" },
      { login: "pending-pat", state: "pending", role: "member" },
    ],
    issues: [],
    faults: [],
    pageSize: 100,
    post: "ok",
    nextId: 500,
    tasks: [],
  };
}

function taskAnswers(number: number): TaskAnswers {
  return {
    number,
    view: {
      workItem: { repo: REPO, number },
      requirements: REQUIREMENTS,
      revision: null,
      target: { branch: `agent/issue-${number}`, commit: COMMIT },
      containsTarget: true,
      results: [],
      hold: null,
      permissions: { land: false },
    },
    causes: [],
    previous: null,
    machine: [],
    failure: null,
  };
}

// Issue `number` with `label` applied by `actor` in event `eventId`.
function labelledIssue(
  number: number,
  label: string,
  actor: string,
  eventId: number,
): FakeIssue {
  return {
    number,
    pullRequest: false,
    labels: [label],
    events: [
      {
        id: eventId,
        event: "labeled",
        label,
        actor,
        viaApp: false,
        createdAt: "2026-10-25T10:00:00Z",
      },
    ],
    comments: [],
  };
}

// Issue `number`'s open PR from its own branch, authored by the
// development account.
function openPull(number: number, pr: number): FakePull {
  return {
    number: pr,
    head: `agent/issue-${number}`,
    base: "main",
    title: `Issue ${number}`,
    body: `Closes #${number}`,
    author: "lawd-dev",
    state: "OPEN",
    isDraft: false,
    reviews: [],
  };
}

// A review by `author` of `commitId`, submitted at minute `id` mod 60.
function review(
  id: number,
  author: string,
  state: FakeReview["state"],
  commitId: string,
): FakeReview {
  const minute = String(id % MINUTES).padStart(2, "0");
  return {
    id,
    author,
    state,
    commitId,
    body: "",
    submittedAt: `2026-10-25T11:${minute}:00Z`,
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// The origin with `main` at one commit, and a work clone to push from.
function origin(root: string): { origin: string; work: string } {
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  git(root, ["clone", "--quiet", bare, work]);
  git(work, ["config", "user.name", "Signal test"]);
  git(work, ["config", "user.email", "signals@example.test"]);
  git(work, ["checkout", "--quiet", "-b", "main"]);
  fs.writeFileSync(path.join(work, "README.md"), "widgets\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "--quiet", "-m", "Target"]);
  git(work, ["push", "--quiet", "origin", "main"]);
  return { origin: bare, work };
}

function harness(edit: (world: World) => void = () => undefined): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  // The pipeline root, where gh runs and the journal lives.
  fs.mkdirSync(path.join(root, "pipeline"));
  const repository = origin(root);
  const worldFile = path.join(root, "world.json");
  const logFile = path.join(root, "gh.log");
  fs.writeFileSync(logFile, "");
  const credentials = path.join(root, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\nISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\n",
    { mode: 0o600 },
  );
  const config = path.join(root, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: REPO,
      devAccount: "lawd-dev",
      landingAccount: LANDING,
      credentialsEnvFile: credentials,
      allowedUsers: ["autumn"],
      projectPolicy: committedPolicy(
        path.join(root, "policy"),
        `https://github.com/${REPO}.git`,
        { commands: { test: "true" }, resources: { modelSessions: 1 } },
      ),
      models: { author: "m", developer: "m", reviewer: "m" },
    }),
  );
  const initial = baseWorld();
  edit(initial);
  writeWorld(worldFile, initial);
  const { PATH: inheritedPath = "" } = process.env;
  const env = Object.fromEntries([
    ["PATH", `${bin}:${inheritedPath}`],
    ["HOME", root],
    ["ISSUE_PIPELINE_ROOT", path.join(root, "pipeline")],
    ["FAKE_GH_WORLD", worldFile],
    ["FAKE_GH_LOG", logFile],
    ["FAKE_GH_ORIGIN", repository.origin],
    ["NODE_COMPILE_CACHE", path.join(root, "compile-cache")],
  ]);
  const { change } = startFakeGitHub({
    root,
    bin,
    world: worldFile,
    log: logFile,
    env: { ...process.env, ...env },
  });
  function drive(request: object): unknown {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(HERE, "fake-tasks-hook.ts"),
        path.join(HERE, "drive-signals.ts"),
        config,
        JSON.stringify(request),
      ],
      { encoding: "utf8", env },
    );
    if (result.status !== 0) {
      throw new Error(`driver failed (${result.status}): ${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  }
  function calls(): Logged[] {
    return fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => LOGGED.parse(JSON.parse(line)));
  }
  function poll(organization: string = ORGANIZATION): Inbox {
    return INBOX.parse(
      drive({ call: "poll", organization, buddyRun: BUDDY_RUN }),
    );
  }
  function requalify(
    signal: unknown,
    organization: string = ORGANIZATION,
  ): Verdict {
    return VERDICT.parse(drive({ call: "requalify", organization, signal }));
  }
  function requalifyNow(
    source: unknown,
    organization: string = ORGANIZATION,
  ): Verdict {
    return VERDICT.parse(
      drive({ call: "requalify-now", organization, source }),
    );
  }
  function latch(number: number): Verdict {
    return VERDICT.parse(drive({ call: "latch", number }));
  }
  function latchNow(number: number): Verdict {
    return VERDICT.parse(drive({ call: "latch-now", number }));
  }
  function posts(): number {
    return calls().filter((call) => call.args.includes("POST")).length;
  }
  function journal(number: number): string[] {
    const dir = path.join(
      root,
      "pipeline",
      "runs",
      "acme__widgets",
      `issue-${number}`,
    );
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir);
  }
  function world(): World {
    return readWorld(worldFile);
  }
  function push(number: number): string {
    const { work } = repository;
    const branch = `agent/issue-${number}`;
    const known = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: work },
    );
    if (known.status === 0) {
      git(work, ["checkout", "--quiet", branch]);
    } else {
      git(work, ["checkout", "--quiet", "-b", branch, "main"]);
    }
    fs.appendFileSync(path.join(work, `issue-${number}.txt`), "change\n");
    git(work, ["add", "."]);
    git(work, ["commit", "--quiet", "-m", `Work on #${number}`]);
    git(work, ["push", "--quiet", "origin", branch]);
    return git(work, ["rev-parse", "HEAD"]);
  }
  return {
    root,
    push,
    world,
    change,
    poll,
    requalify,
    requalifyNow,
    latch,
    latchNow,
    calls,
    posts,
    journal,
  };
}

// A pattern matching text that mentions each of `parts`, literally, in
// order.
function mentions(...parts: string[]): RegExp {
  const escaped = parts.map((part) => part.replace(REGEX_SPECIAL, "\\$&"));
  return new RegExp(escaped.join("[\\s\\S]*"), "u");
}

// The accepted-signal records on issue `number` in the world, parsed.
function records(world: World, number: number): unknown[] {
  const issue = world.issues.find((item) => item.number === number);
  return (issue?.comments ?? [])
    .filter((item) => item.body.startsWith(MARK))
    .map((item): unknown =>
      JSON.parse(item.body.slice(MARK.length, -"\n-->".length)),
    );
}

export type { Harness, Inbox };
export {
  BUDDY_RUN,
  baseWorld,
  COMMIT,
  harness,
  LANDING,
  labelledIssue,
  MARK,
  mentions,
  ORGANIZATION,
  OTHER_COMMIT,
  OTHER_REQUIREMENTS,
  openPull,
  REPO,
  REQUIREMENTS,
  records,
  review,
  taskAnswers,
};
