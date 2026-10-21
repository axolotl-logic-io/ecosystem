// @ts-check
// A pipeline root with a local origin, for tests that run the ops CLI against
// real git repos and the fake gh. opsFixture() must run before anything from
// src/ is imported, since the pipeline root is read once, on import.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installFakeGh } from "./fake-gh.mjs";
import { OPS, runOps, setEnv, sh } from "./ops-run-test-kit.mjs";

/** @import { FakeGh } from "./fake-gh.mjs" */

const BASE = "integration";

/**
 * The fixture's repos: the root, the bare origin, the seed clone that commits
 * to it, the pipeline's clone, and how to make an issue's worktree.
 * @typedef {object} Repos
 * @property {string} root
 * @property {string} origin
 * @property {string} seed
 * @property {string} clone
 * @property {(n: number) => void} ensureWorktree
 */

/**
 * The git helpers for the origin, the seed clone and the issue worktrees.
 * @typedef {object} GitHelpers
 * @property {(n: number) => string} worktree
 * @property {(ref: string) => string} originRef
 * @property {(file: string, text: string) => string} advanceBase
 * @property {(n: number, file: string, text: string, message?: string) => string} commitIn
 * @property {() => void} fetchClone
 * @property {(n: number, file: string, text: string) => string} startBranch
 * @property {(n: number) => boolean} inRebase
 * @property {(n: number) => { head: string, status: string }} worktreeState
 * @property {(n: number) => string} pushFrom
 */

/**
 * The fixture: the root, the fake gh, ask() to run one ops request,
 * configWith() for a config with extra settings, and the git helpers.
 * @typedef {GitHelpers & {
 *   root: string,
 *   fakeGh: FakeGh,
 *   ask: (request: object, configFile?: string) => string,
 *   configWith: (fileName: string, extra: object) => string,
 *   sh: (command: string) => string,
 * }} OpsFixture
 */

/**
 * @param {string} file
 * @param {object} extra
 * @returns {void}
 */
function writeConfig(file, extra) {
  const config = {
    repo: "o/r",
    ...credentialConfig("a"),
    allowedUsers: ["a"],
    commands: { test: "true" },
    baseBranch: BASE,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(config));
}

/**
 * A bare origin on the base branch with one commit, made through the seed.
 * @param {string} origin
 * @param {string} seed
 * @returns {void}
 */
function seedOrigin(origin, seed) {
  sh(`git init -q --bare -b ${BASE} ${origin}`);
  sh(`git clone -q ${origin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(`cd ${seed} && echo base > f && git add f && git commit -qm base`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
}

/**
 * @param {Repos} repos
 * @param {number} n
 * @returns {string}
 */
function worktreeOf({ root }, n) {
  return path.join(root, "work", "o__r", `issue-${n}`);
}

/**
 * The sha of a ref on origin, or "" when it has none.
 * @param {Repos} repos
 * @param {string} ref
 * @returns {string}
 */
function originRefOf({ origin }, ref) {
  return sh(`git --git-dir ${origin} rev-parse -q --verify ${ref} || true`);
}

/**
 * Commits a file on the base branch through the seed clone.
 * @param {Repos} repos
 * @param {string} file
 * @param {string} text
 * @returns {string}
 */
function advanceBaseOf(repos, file, text) {
  const { seed } = repos;
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  sh(`cd ${seed} && printf '${text}\\n' > ${file} && git add ${file}`);
  sh(
    `cd ${seed} && git commit -qm "base ${file}" && git push -q origin HEAD:${BASE}`,
  );
  return originRefOf(repos, BASE);
}

/**
 * Commits a file in an issue's worktree; returns the new head.
 * @param {Repos} repos
 * @param {number} n
 * @param {{ file: string, text: string, message: string }} commit
 * @returns {string}
 */
function commitInOf(repos, n, { file, text, message }) {
  const wt = worktreeOf(repos, n);
  fs.writeFileSync(path.join(wt, file), `${text}\n`);
  sh(`cd ${wt} && git add ${file} && git commit -qm "${message}"`);
  return sh(`git -C ${wt} rev-parse HEAD`);
}

/**
 * Brings the clone's origin/integration up to date with origin.
 * @param {Repos} repos
 * @returns {void}
 */
function fetchCloneOf({ clone }) {
  sh(`git -C ${clone} fetch -q origin`);
}

/**
 * True while a rebase is stopped in the issue's worktree.
 * @param {Repos} repos
 * @param {number} n
 * @returns {boolean}
 */
function inRebaseOf(repos, n) {
  const wt = worktreeOf(repos, n);
  return ["rebase-merge", "rebase-apply"].some((dir) => {
    const where = sh(`git -C ${wt} rev-parse --git-path ${dir}`);
    return fs.existsSync(path.resolve(wt, where));
  });
}

/**
 * Pushes an issue's worktree head to its branch on origin, as the ops CLI
 * would (the clone's pre-push hook admits only it).
 * @param {Repos} repos
 * @param {number} n
 * @returns {string}
 */
function pushFromOf(repos, n) {
  const target = `HEAD:refs/heads/agent/issue-${n}`;
  sh(
    `ISSUE_PIPELINE_OPS=1 git -C ${worktreeOf(repos, n)} push -qf origin ${target}`,
  );
  return originRefOf(repos, `agent/issue-${n}`);
}

/**
 * The git helpers, bound to the fixture's repos.
 * @param {Repos} r
 * @returns {GitHelpers}
 */
function gitHelpers(r) {
  return {
    worktree: (n) => worktreeOf(r, n),
    originRef: (ref) => originRefOf(r, ref),
    advanceBase: (file, text) => advanceBaseOf(r, file, text),
    commitIn: (n, file, text, message = `edit ${file}`) =>
      commitInOf(r, n, { file, text, message }),
    fetchClone: () => fetchCloneOf(r),
    // Starts an issue's branch on the current base with one commit of
    // `file`, pushed to origin; returns its head.
    startBranch: (n, file, text) => {
      fetchCloneOf(r);
      r.ensureWorktree(n);
      commitInOf(r, n, { file, text, message: `edit ${file}` });
      return pushFromOf(r, n);
    },
    inRebase: (n) => inRebaseOf(r, n),
    // The worktree's head and `git status --porcelain`.
    worktreeState: (n) => ({
      head: sh(`git -C ${worktreeOf(r, n)} rev-parse HEAD`),
      status: sh(`git -C ${worktreeOf(r, n)} status --porcelain`),
    }),
    pushFrom: (n) => pushFromOf(r, n),
  };
}

/**
 * Makes the fixture, named `name` in its temp folder's name.
 * @param {string} name
 * @returns {Promise<OpsFixture>}
 */
async function opsFixture(name) {
  const root = fs.mkdtempSync(`/tmp/issue-pipeline-${name}-`);
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  setEnv("ISSUE_PIPELINE_ROOT", root);
  setEnv("HOME", home);
  const pipelineRoot = await import("../src/pipeline-root.ts");
  if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== home) {
    throw new Error("src took a pipeline root outside the fixture's folder");
  }
  const fakeGh = installFakeGh();
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  seedOrigin(origin, seed);
  const config = path.join(root, "config.json");
  writeConfig(config, { cloneUrl: origin });
  const { loadConfig } = await import("../src/config.ts");
  const { ensureClone, ensureWorktree } = await import("../src/checkouts.ts");
  const cfg = loadConfig(config);
  const clone = ensureClone(cfg);
  /** @type {Repos} */
  const repos = {
    root,
    origin,
    seed,
    clone,
    ensureWorktree: (n) => {
      ensureWorktree(cfg, n);
    },
  };
  return {
    root,
    fakeGh,
    // The raw stdout of one ops request, framed as the workflow frames it.
    ask: (request, configFile = config) =>
      runOps({ config: configFile, request, root }),
    // A config file with extra settings.
    configWith: (fileName, extra) => {
      const file = path.join(root, fileName);
      writeConfig(file, { cloneUrl: origin, ...extra });
      return file;
    },
    sh,
    ...gitHelpers(repos),
  };
}

/**
 * The stdout the ops CLI prints for a successful op's reply that posted no
 * comments: no count and no comment ids.
 * @param {string} op
 * @param {object} reply
 * @returns {string}
 */
function okLine(op, reply) {
  return `${JSON.stringify({ ok: true, op, posted: 0, commentIds: [], ...reply })}\n`;
}

/**
 * True when src/ops.ts still defines the handler itself: names the op as a
 * string literal, as a Map entry does, or assigns it as `ops["x"] =` or
 * `ops.x =`.
 * @param {string} name
 * @returns {boolean}
 */
function opsSourceDefines(name) {
  const source = fs.readFileSync(OPS, "utf8");
  return source.includes(`"${name}"`) || source.includes(`ops.${name} =`);
}

// The gh call that reads an issue's saved state, as a push does before it
// pushes code: the issue's comments, where a codeMerged would refuse it.
/** @param {number} n @returns {string[]} */
function stateReadCall(n) {
  return [
    "api",
    "--paginate",
    `repos/o/r/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

export { okLine, opsFixture, opsSourceDefines, stateReadCall };
