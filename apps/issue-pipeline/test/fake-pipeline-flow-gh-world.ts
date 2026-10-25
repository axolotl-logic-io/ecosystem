// The fake GitHub's world: one repo's issues, comments, labels and pull
// requests in world.json, changed only under its lock, and the git reads of
// the bare origin its pull requests live in.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { FlowEvent } from "./fake-pipeline-flow-gh-assignments.ts";

// A comment as the world keeps it; `issue` is the number it is on.
interface FlowComment {
  id: number;
  body: string;
  login: string;
  createdAt: string;
  updatedAt: string;
  issue: number;
}

// An issue, or the issue GitHub also keeps for each PR (`isPull`).
interface FlowIssue {
  number: number;
  title: string;
  body: string;
  login: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  createdAt: string;
  isPull?: boolean;
  // logins, in the order assigned
  assignees?: string[];
}

// A pull request; its head is the origin's `head` branch until it merges,
// then `mergedHead`, as GitHub keeps it after the branch goes.
interface FlowPr {
  number: number;
  head: string;
  base: string;
  isCrossRepository?: boolean;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeOid: string | null;
  // retained head after closing/deleting the branch
  closedHead?: string | null;
  mergedHead: string | null;
}

interface World {
  repo: string;
  account: string;
  collaborators: string[];
  // the repo's bare origin
  origin: string;
  // configured target, independent of the default branch
  baseBranch: string;
  // seed updates excluded from this flow
  nativePushStart: number;
  // consumed receive-pack observations
  nativePushesSeen: number;
  // the next issue, PR or comment number
  nextId: number;
  issues: FlowIssue[];
  comments: FlowComment[];
  repoLabels: string[];
  prs: FlowPr[];
  // exact head with a scripted CI failure
  failedHead?: string | null;
  // project incompatible CLOSED evidence until explicit recovery
  withholdMergeBinding?: boolean;
  // the coordination transport's epoch refs, by full name
  refs?: Record<string, string>;
  // the calls the fake refused
  unsupported: string[][];
  // assignment events
  events?: FlowEvent[];
  // listings gh cuts short, by route
  cutShort?: string[];
}

interface Answer {
  stdout?: string;
  stderr?: string;
  code?: number;
}

const LOCK_WAIT_MS = 10;
const LOCK_TRIES = 3000;
const SLEEPER = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const GIT_ID = [
  "-c",
  "user.name=GitHub",
  "-c",
  "user.email=github@example.com",
  "-c",
  "commit.gpgsign=false",
];

function worldFile(dir: string): string {
  return path.join(dir, "world.json");
}

function readWorld(dir: string): World {
  return JSON.parse(fs.readFileSync(worldFile(dir), "utf8"));
}

function writeWorld(dir: string, world: World): void {
  const temp = `${worldFile(dir)}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(world, null, 1));
  fs.renameSync(temp, worldFile(dir));
}

function takeLock(lock: string, tries: number): void {
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (tries >= LOCK_TRIES) {
      throw error;
    }
    Atomics.wait(SLEEPER, 0, 0, LOCK_WAIT_MS);
    takeLock(lock, tries + 1);
  }
}

// Runs `change` on the world under the world's lock and saves it.
function withWorld<T>(dir: string, change: (world: World) => T): T {
  const lock = path.join(dir, "world.lock");
  takeLock(lock, 0);
  try {
    const world = readWorld(dir);
    const result = change(world);
    writeWorld(dir, world);
    return result;
  } finally {
    fs.rmdirSync(lock);
  }
}

function gitIn(origin: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", origin, ...GIT_ID, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitSucceeds(origin: string, args: readonly string[]): boolean {
  try {
    gitIn(origin, args);
    return true;
  } catch {
    return false;
  }
}

function branchHead(origin: string, branch: string): string | null {
  try {
    return gitIn(origin, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

function issueOf(world: World, n: number): FlowIssue {
  const found = world.issues.find((item) => item.number === n);
  if (found === undefined) {
    throw new Error(`HTTP 404: no issue #${n}`);
  }
  return found;
}

// Adds `login`'s comment `body` to issue `n`.
function postComment(
  world: World,
  n: number,
  login: string,
  body: string,
): FlowComment {
  issueOf(world, n);
  const at = now();
  const posted = {
    id: world.nextId,
    body,
    login,
    createdAt: at,
    updatedAt: at,
    issue: n,
  };
  world.nextId += 1;
  world.comments.push(posted);
  return posted;
}

// The comment as GitHub's REST API gives it, in its snake_case names.
function restComment(
  world: World,
  posted: FlowComment,
): Record<string, unknown> {
  return Object.fromEntries([
    ["id", posted.id],
    ["node_id", `comment-${posted.id}`],
    ["body", posted.body],
    ["user", { login: posted.login }],
    ["created_at", posted.createdAt],
    ["updated_at", posted.updatedAt],
    [
      "issue_url",
      `https://api.github.com/repos/${world.repo}/issues/${posted.issue}`,
    ],
  ]);
}

function restIssue(item: FlowIssue): Record<string, unknown> {
  return Object.fromEntries([
    ["number", item.number],
    ["title", item.title],
    ["body", item.body],
    ["user", { login: item.login }],
    ["state", item.state],
    ["state_reason", item.stateReason],
    ["labels", item.labels.map((name) => ({ name }))],
    ["assignees", (item.assignees ?? []).map((login) => ({ login }))],
    ["created_at", item.createdAt],
  ]);
}

// The value of each `flag` in `args`, in order.
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, at) => {
    if (arg === flag && at + 1 < args.length) {
      return [String(args[at + 1])];
    }
    return [];
  });
}

function flagValue(args: readonly string[], flag: string): string | null {
  return flagValues(args, flag)[0] ?? null;
}

// `value` cut to gh's `--json` fields, printed as gh prints it.
function jsonAnswer(
  value: Record<string, unknown>,
  fields: string | null,
): Answer {
  const picked = Object.fromEntries(
    String(fields)
      .split(",")
      .map((field) => [field, value[field]]),
  );
  return { stdout: `${JSON.stringify(picked)}\n` };
}

export type { Answer, FlowComment, FlowIssue, FlowPr, World };
export {
  branchHead,
  flagValue,
  gitIn,
  gitSucceeds,
  issueOf,
  jsonAnswer,
  now,
  postComment,
  readWorld,
  restComment,
  restIssue,
  withWorld,
  writeWorld,
};
