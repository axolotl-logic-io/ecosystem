// @ts-check
// The fake GitHub's world: one repo's issues, comments, labels and pull
// requests in world.json, changed only under its lock, and the git reads of
// the bare origin its pull requests live in.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * A comment as the world keeps it; `issue` is the number it is on.
 * @typedef {object} FlowComment
 * @property {number} id
 * @property {string} body
 * @property {string} login
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} issue
 */

/**
 * An issue, or the issue GitHub also keeps for each PR (`isPull`).
 * @typedef {object} FlowIssue
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string} login
 * @property {"open" | "closed"} state
 * @property {string | null} stateReason
 * @property {string[]} labels
 * @property {string} createdAt
 * @property {boolean} [isPull]
 */

/**
 * A pull request; its head is the origin's `head` branch until it merges,
 * then `mergedHead`, as GitHub keeps it after the branch goes.
 * @typedef {object} FlowPr
 * @property {number} number
 * @property {string} head
 * @property {string} base
 * @property {boolean} [isCrossRepository]
 * @property {string} title
 * @property {string} body
 * @property {"OPEN" | "CLOSED" | "MERGED"} state
 * @property {boolean} isDraft
 * @property {string | null} mergeOid
 * @property {string | null} [closedHead] retained head after closing/deleting the branch
 * @property {string | null} mergedHead
 */

/**
 * @typedef {object} World
 * @property {string} repo
 * @property {string} account
 * @property {string[]} collaborators
 * @property {string} origin the repo's bare origin
 * @property {string} baseBranch configured target, independent of the default branch
 * @property {number} nativePushStart seed updates excluded from this flow
 * @property {number} nativePushesSeen consumed receive-pack observations
 * @property {number} nextId the next issue, PR or comment number
 * @property {FlowIssue[]} issues
 * @property {FlowComment[]} comments
 * @property {string[]} repoLabels
 * @property {FlowPr[]} prs
 * @property {string | null} [failedHead] exact head with a scripted CI failure
 * @property {boolean} [withholdMergeBinding] project incompatible CLOSED evidence until explicit recovery
 * @property {Record<string, string>} [refs] the coordination transport's epoch refs, by full name
 * @property {string[][]} unsupported the calls the fake refused
 */

/** @typedef {{ stdout?: string, stderr?: string, code?: number }} Answer */

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

/** @param {string} dir @returns {string} */
function worldFile(dir) {
  return path.join(dir, "world.json");
}

/** @param {string} dir @returns {World} */
function readWorld(dir) {
  return JSON.parse(fs.readFileSync(worldFile(dir), "utf8"));
}

/** @param {string} dir @param {World} world */
function writeWorld(dir, world) {
  const temp = `${worldFile(dir)}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(world, null, 1));
  fs.renameSync(temp, worldFile(dir));
}

/** @param {string} lock @param {number} tries */
function takeLock(lock, tries) {
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

/**
 * Runs `change` on the world under the world's lock and saves it.
 * @template T
 * @param {string} dir
 * @param {(world: World) => T} change
 * @returns {T}
 */
function withWorld(dir, change) {
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

/** @param {string} origin @param {readonly string[]} args @returns {string} */
function gitIn(origin, args) {
  return execFileSync("git", ["--git-dir", origin, ...GIT_ID, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** @param {string} origin @param {readonly string[]} args @returns {boolean} */
function gitSucceeds(origin, args) {
  try {
    gitIn(origin, args);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} origin @param {string} branch @returns {string | null} */
function branchHead(origin, branch) {
  try {
    return gitIn(origin, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  } catch {
    return null;
  }
}

/** @returns {string} */
function now() {
  return new Date().toISOString();
}

/** @param {World} world @param {number} n @returns {FlowIssue} */
function issueOf(world, n) {
  const found = world.issues.find((item) => item.number === n);
  if (found === undefined) {
    throw new Error(`HTTP 404: no issue #${n}`);
  }
  return found;
}

/**
 * Adds `login`'s comment `body` to issue `n`.
 * @param {World} world @param {number} n @param {string} login @param {string} body
 * @returns {FlowComment}
 */
function postComment(world, n, login, body) {
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

/**
 * The comment as GitHub's REST API gives it, in its snake_case names.
 * @param {World} world @param {FlowComment} posted
 */
function restComment(world, posted) {
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

/** @param {FlowIssue} item */
function restIssue(item) {
  return Object.fromEntries([
    ["number", item.number],
    ["title", item.title],
    ["body", item.body],
    ["user", { login: item.login }],
    ["state", item.state],
    ["state_reason", item.stateReason],
    ["labels", item.labels.map((name) => ({ name }))],
    ["created_at", item.createdAt],
  ]);
}

/**
 * The value of each `flag` in `args`, in order.
 * @param {readonly string[]} args @param {string} flag @returns {string[]}
 */
function flagValues(args, flag) {
  return args.flatMap((arg, at) => {
    if (arg === flag && at + 1 < args.length) {
      return [String(args[at + 1])];
    }
    return [];
  });
}

/**
 * @param {readonly string[]} args @param {string} flag
 * @returns {string | null}
 */
function flagValue(args, flag) {
  return flagValues(args, flag)[0] ?? null;
}

/**
 * `value` cut to gh's `--json` fields, printed as gh prints it.
 * @param {Record<string, unknown>} value @param {string | null} fields
 * @returns {Answer}
 */
function jsonAnswer(value, fields) {
  const picked = Object.fromEntries(
    String(fields)
      .split(",")
      .map((field) => [field, value[field]]),
  );
  return { stdout: `${JSON.stringify(picked)}\n` };
}

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
