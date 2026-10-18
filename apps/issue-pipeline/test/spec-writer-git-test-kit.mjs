// @ts-check
// The spec writer on the runner with its real checks (#334): issue #7 of a
// repo of its own, with bare origins for the code and the wiki
// (job-git-test-kit.mjs), a real job checkout (openJobCheckout), the mock
// session, which commits its files and pushes them as pipeline_commit would,
// and the op fakes of spec-writer-run-test-kit.mjs over the fake gh. After
// the run the checkout is closed as the job's exit closes it, with an exit
// push that pushes what the remotes lack, as exit-push does.
// Importing it sets the pipeline root to a temp folder, so it comes before
// anything a test imports from src/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  BASE,
  branchOnOrigin,
  refOf,
  seedOrigins,
  WIKI_BRANCH,
} from "./job-git-test-kit.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";
import { killAt } from "./runner-test-kit.mjs";
import { replyOf, specContext } from "./spec-writer-role-test-kit.mjs";
import { restarts, SPEC_OPS, specState } from "./spec-writer-run-test-kit.mjs";

/** @import { Kill, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */
/** @import { SweepConfig } from "../src/workflow/stages/types.ts" */
/** @import { Outcome } from "../src/job/run-step.ts" */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-writer-role-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", root);
const { loadConfig } = await import("../src/config.ts");
const { closeJobCheckout, openJobCheckout } = await import(
  "../src/job/checkout.ts"
);
const { roleOf } = await import("../src/roles/registry.ts");
const { ROOT } = await import("../src/pipeline-root.ts");
if (ROOT !== root) {
  throw new Error(
    `src/ was imported before this kit set the pipeline root, which is ${ROOT}: import this kit first`,
  );
}

const ISSUE = 7;
// The issue a stacked #7 is stacked on.
const STACKED_ON = 6;
const BRANCH = "refs/heads/agent/issue-7";
// Runs every test file there is, so a new failing test fails the command.
const RUN_TESTS =
  'for t in test/*.test.sh; do [ -e "$t" ] || continue; sh "$t" || exit 1; done';
// The hooks in a job checkout let only pipeline_commit commit, and only the
// job, which pushes for it, push.
const COMMIT_ENV = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["ISSUE_PIPELINE_OPS", "1"],
]);
const IDENTITY = ["-c", "user.name=Spec", "-c", "user.email=spec@example.com"];
// The trailer line that ends each of the spec writer's commits (task.ts).
const SPEC_TRAILER = "Pipeline-Agent: spec writer";

/** @typedef {Readonly<Record<string, string>>} Files */

/**
 * @typedef {object} Setup
 * @property {Record<string, unknown>[]} [replies] the session's replies, in turn; the last repeats
 * @property {Files} [code] what each session commits to the code branch
 * @property {Files[]} [codes] what each session commits to the code branch, in turn, in place of `code`; the last repeats
 * @property {Files} [wiki] what each session commits to the wiki branch
 * @property {boolean} [existing] whether the branches exist before the stage
 * @property {boolean} [pushedMeanwhile] whether a person pushes a commit to both branches after the session's own push
 * @property {boolean} [stacked] whether the issue is stacked on #6's branch
 * @property {Record<string, unknown>} [start] fields of the state the run starts from
 * @property {(origin: string) => Record<string, unknown>} [prepare] builds the origin's branches before the job's checkout opens, and gives fields of the state the run starts from
 * @property {Record<string, OpFake>} [ops] op fakes in place of the kit's
 * @property {string} [testCommand] the config's test command, in place of running every test file
 * @property {Partial<SweepConfig>} [sweep] fields of the context's config in place of its own
 * @property {string} [handoff] the handoff file an earlier session left, if any
 * @property {Kill} [kill] the effect call the first run is killed at, before the run starts again
 */

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync("git", [...IDENTITY, "-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...Object.fromEntries(COMMIT_ENV) },
  }).trim();
}

/**
 * Commits and pushes `files`, as pipeline_commit would; a retry's session
 * that changes nothing commits nothing.
 * @param {string} dir
 * @param {Files} files
 */
function commitPush(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  if (git(dir, ["status", "--porcelain"]) === "") {
    return;
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "spec", "-m", SPEC_TRAILER]);
  git(dir, ["push", "--quiet", "origin", `HEAD:${BRANCH}`]);
}

/**
 * A person's push of a commit of their own to the issue's branch on `origin`,
 * from a clone of their own.
 * @param {string} origin
 */
function personPushes(origin) {
  const clone = fs.mkdtempSync(path.join(root, "person-"));
  git(clone, ["clone", "--quiet", "--branch", "agent/issue-7", origin, "."]);
  fs.writeFileSync(path.join(clone, "person.txt"), "mine\n");
  git(clone, ["add", "person.txt"]);
  git(clone, ["commit", "--quiet", "-m", "A person's commit"]);
  git(clone, ["push", "--quiet", "origin", `HEAD:${BRANCH}`]);
}

let repos = 0;

/** @param {Setup} setup a repo of its own, with the job's checkout opened */
function repoOf(setup) {
  repos += 1;
  const tmp = path.join(root, `repo-${repos}`);
  fs.mkdirSync(tmp);
  const origins = seedOrigins(tmp, true);
  const { origin } = origins;
  const wikiOrigin = String(origins.wikiOrigin);
  const config = {
    repo: `o/r${repos}`,
    account: "bot",
    allowedUsers: ["alice"],
    commands: { test: setup.testCommand ?? RUN_TESTS },
    ...origins.config,
  };
  const file = path.join(tmp, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  const cfg = loadConfig(file);
  const heads = { code: "", wiki: "" };
  const bases = {
    code: refOf(origin, `refs/heads/${BASE}`),
    wiki: refOf(wikiOrigin, `refs/heads/${WIKI_BRANCH}`),
  };
  if (setup.existing === true) {
    heads.code = branchOnOrigin(origin);
    heads.wiki = branchOnOrigin(wikiOrigin);
  }
  /** @type {Record<string, unknown>} */
  let stacked = { ...setup.prepare?.(origin) };
  let stackOn = null;
  if (setup.stacked === true) {
    stackOn = STACKED_ON;
    const headSha = branchOnOrigin(origin, stackOn);
    stacked = { ...stacked, stackedOn: { issue: stackOn, headSha } };
  }
  /** @type {{ stage: string, stackOn: number | null, wiki: "write" }} */
  const job = { stage: "spec", stackOn, wiki: "write" };
  const dirs = openJobCheckout(cfg, ISSUE, job);
  if (dirs.docs === null) {
    throw new Error("the job's wiki checkout didn't open");
  }
  const { root: folder, repo: dir, docs: wikiDir } = dirs;
  return {
    cfg,
    handoffFile: path.join(tmp, "handoff.md"),
    origin,
    wikiOrigin,
    folder,
    dir,
    wikiDir,
    heads,
    bases,
    stacked,
  };
}

/**
 * The world and role run of a spec stage on a repo of its own.
 * @param {Setup} setup
 */
function specRun(setup) {
  const repo = repoOf(setup);
  const { cfg, folder, dir, wikiDir, stacked, handoffFile } = repo;
  if (setup.handoff !== undefined) {
    fs.writeFileSync(handoffFile, setup.handoff);
  }
  const base = specContext();
  /** @type {{ dir: string, docs: "write" }} */
  const job = { dir: folder, docs: "write" };
  const paths = {
    ...base.paths,
    worktree: dir,
    wiki: wikiDir,
    handoffFile,
    job,
  };
  const replies = setup.replies ?? [replyOf()];
  /** @type {string[]} */
  const tasks = [];
  let sessions = 0;
  /** @param {{ task: string }} effect @returns {Outcome} */
  function session(effect) {
    tasks.push(effect.task);
    const codes = setup.codes ?? [setup.code ?? {}];
    commitPush(dir, codes[Math.min(sessions, codes.length - 1)] ?? {});
    commitPush(wikiDir, setup.wiki ?? {});
    if (setup.pushedMeanwhile === true) {
      personPushes(repo.origin);
      personPushes(repo.wikiOrigin);
    }
    const reply = replies[Math.min(sessions, replies.length - 1)];
    sessions += 1;
    return { ok: true, name: "replied", reply };
  }
  /** @type {WorldOptions} */
  const options = {
    start: () => specState({ ...stacked, ...setup.start }),
    context: { ...base, paths, cfg: { ...base.cfg, ...setup.sweep } },
    session,
    ops: { ...SPEC_OPS, ...setup.ops },
    restarts,
  };
  /** @type {RoleRun} */
  function run(entry, effects) {
    const role = roleOf("spec");
    if (role === undefined) {
      throw new Error("spec isn't registered");
    }
    return role.run(entry, effects, cfg);
  }
  return { repo, options, run, tasks };
}

/** @param {string} dir @returns {number} the commits of `dir` no origin branch has */
function unpushed(dir) {
  git(dir, ["fetch", "--quiet", "--prune", "origin"]);
  return Number(
    git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]),
  );
}

/**
 * Closes the run's checkout as the job's exit does. `heads` are the code and
 * wiki checkouts' heads before it closes, and `pushes` the checkouts the
 * exit push pushed to the issue's branch because their remote lacked them.
 * @param {ReturnType<typeof repoOf>} repo
 */
async function exitOf(repo) {
  const { cfg, folder, dir, wikiDir } = repo;
  const heads = {
    code: git(dir, ["rev-parse", "HEAD"]),
    wiki: git(wikiDir, ["rev-parse", "HEAD"]),
  };
  let pushes = 0;
  function push() {
    for (const checkout of [dir, wikiDir]) {
      if (unpushed(checkout) > 0) {
        git(checkout, ["push", "--quiet", "origin", `HEAD:${BRANCH}`]);
        pushes += 1;
      }
    }
    return Promise.resolve();
  }
  /** @type {{ root: string, repo: string, docs: string, wiki: "write", key: string }} */
  const job = {
    root: folder,
    repo: dir,
    docs: wikiDir,
    wiki: "write",
    key: "spec-1",
  };
  await closeJobCheckout(cfg, ISSUE, job, push);
  return { heads, pushes };
}

/** @param {Setup} setup runs the spec stage to its end, killed and started again if it says so, then closes its checkout */
async function specWriter(setup) {
  const { repo, options, run, tasks } = specRun(setup);
  const ran = await killAt(run, setup.kill, options);
  return { ...ran, repo, tasks, exit: await exitOf(repo) };
}

export { BRANCH, specWriter };
