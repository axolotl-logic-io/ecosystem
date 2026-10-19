// @ts-check
// The full-flow tests' world: the pipeline as build.ts builds it (ops.mjs,
// job.mjs, orchestrate.mjs and the pi extensions) in a temporary pipeline
// root under a temporary HOME, real bare git origins for the repo and its
// wiki submodule, the stateful fake GitHub (pipeline-flow-gh.mjs) and the
// scripted fake pi (pipeline-flow-pi.mjs) first on PATH. A tick runs the
// built orchestrator once, which starts the stage jobs it decides on as
// detached job.mjs processes (pipeline-flow-run.mjs waits for them).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { writeBrain } from "./brain-test-kit.mjs";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { installFlowGh } from "./pipeline-flow-gh.mjs";
import { installFlowPi } from "./pipeline-flow-pi.mjs";
import { FIXTURE_MODELS, provisionFixture } from "./runtime-fixtures.mjs";

const APP = new URL("..", import.meta.url).pathname;
const AGENTS = path.join(APP, "agents");
const BASE = "integration";
const WIKI_BRANCH = "master";
const ISSUE = 7;
const SLUG = "o__r";
// What no process in a flow inherits: a GitHub token, and the commit scope
// of a pipeline session the suite may run inside.
const DROPPED_ENV = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ISSUE_PIPELINE_COMMIT_SCOPE",
]);
// The models the config names, one per role, which tell the fake pi which
// role a session plays.
const MODELS = FIXTURE_MODELS;
const SEED_ID = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];

/**
 * @typedef {object} Flow
 * @property {string} tmp
 * @property {string} home
 * @property {string} root
 * @property {string} config
 * @property {string} origin
 * @property {string} wikiOrigin
 * @property {string} brain the wiki clone the jobs pin their prompts from
 * @property {string} ghDir
 * @property {string} piDir
 * @property {NodeJS.ProcessEnv} env
 * @property {number[]} pids every job pid a tick started
 */

/** @type {string | null} */
let built = null;

/** @returns {string} the build's folder, built once per test process */
function buildOnce() {
  if (built !== null) {
    return built;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-flow-build-"));
  process.on("exit", () => fs.rmSync(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["build.ts", out], {
    cwd: APP,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`build.ts failed: ${result.stderr}`);
  }
  built = out;
  return out;
}

/** @param {readonly string[]} args @param {string} [cwd] */
function seedGit(args, cwd) {
  return execFileSync("git", [...SEED_ID, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([["GIT_ALLOW_PROTOCOL", "file"]]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Seeds bare origins: the wiki with Home.md, and the repo with AGENTS.md,
 * an app file and the wiki as its `wiki` submodule.
 * @param {string} tmp
 */
function seedOrigins(tmp) {
  const origin = path.join(tmp, "origin.git");
  const wikiOrigin = path.join(tmp, "wiki-origin.git");
  const wikiSeed = path.join(tmp, "wiki-seed");
  seedGit(["init", "--quiet", "--bare", "-b", WIKI_BRANCH, wikiOrigin]);
  seedGit(["init", "--quiet", "-b", WIKI_BRANCH, wikiSeed]);
  fs.writeFileSync(path.join(wikiSeed, "Home.md"), "The wiki.\n");
  seedGit(["add", "Home.md"], wikiSeed);
  seedGit(["commit", "--quiet", "-m", "wiki base"], wikiSeed);
  seedGit(
    ["push", "--quiet", wikiOrigin, `HEAD:refs/heads/${WIKI_BRANCH}`],
    wikiSeed,
  );
  const seed = path.join(tmp, "seed");
  seedGit(["init", "--quiet", "--bare", "-b", BASE, origin]);
  seedGit(["init", "--quiet", "-b", BASE, seed]);
  fs.writeFileSync(path.join(seed, "AGENTS.md"), "Keep greetings polite.\n");
  fs.writeFileSync(path.join(seed, "greet.txt"), "hello\n");
  seedGit(["add", "AGENTS.md", "greet.txt"], seed);
  seedGit(["commit", "--quiet", "-m", "base"], seed);
  seedGit(["submodule", "add", "--quiet", wikiOrigin, "wiki"], seed);
  seedGit(["commit", "--quiet", "-m", "Add wiki submodule"], seed);
  seedGit(["push", "--quiet", origin, `HEAD:refs/heads/${BASE}`], seed);
  return { origin, wikiOrigin };
}

/**
 * Installs the build in `root` as install.mjs would, and the agent files
 * where pi reads them.
 * @param {string} root @param {string} agents
 */
function installBuild(root, agents) {
  const out = buildOnce();
  for (const file of fs.readdirSync(out)) {
    fs.copyFileSync(path.join(out, file), path.join(root, file));
  }
  for (const file of fs.readdirSync(AGENTS)) {
    fs.copyFileSync(path.join(AGENTS, file), path.join(agents, file));
  }
}

/** @param {string} config @param {string} origin */
function writeConfig(config, origin) {
  const settings = {
    repo: "o/r",
    ...credentialConfig("bot"),
    allowedUsers: ["alice"],
    baseBranch: BASE,
    cloneUrl: origin,
    wiki: true,
    commands: { test: "true" },
    models: MODELS,
    runtime: provisionFixture(path.dirname(config)),
    requireCi: false,
    gitName: "Pipeline",
    gitEmail: "pipeline@example.com",
    orchestratorIntervalSeconds: 1,
  };
  fs.writeFileSync(config, JSON.stringify(settings));
}

/**
 * Every process's environment: this one's, less any GitHub token and
 * commit scope, with the temporary HOME, root and agent folder, and the
 * fakes first on PATH.
 * @param {{ tmp: string, home: string, root: string, bin: string, piDir: string }} where
 * @returns {NodeJS.ProcessEnv}
 */
function envOf({ tmp, home, root, bin, piDir }) {
  const { PATH: searchPath } = process.env;
  const kept = Object.entries(process.env).filter(
    ([name]) => !DROPPED_ENV.has(name),
  );
  return Object.fromEntries([
    ...kept,
    ["HOME", home],
    ["PATH", `${bin}${path.delimiter}${searchPath}`],
    ["ISSUE_PIPELINE_ROOT", root],
    ["PI_CODING_AGENT_DIR", path.join(tmp, "agent")],
    ["FLOW_PI_DIR", piDir],
    ["PIPELINE_MODEL_KEY", "offline-fixture-credential"],
    ["GIT_ALLOW_PROTOCOL", "file"],
    ["GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig")],
    ["GIT_CONFIG_NOSYSTEM", "1"],
  ]);
}

/**
 * A fresh world: HOME and the pipeline root are temporary, and checked to
 * be under the test's own folder before anything runs.
 * @returns {Flow}
 */
function setUpFlow() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-flow-"));
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const [home, root, bin, ghDir, piDir] = [
    "home",
    "root",
    "bin",
    "github",
    "pi",
  ].map((name) => path.join(tmp, name));
  const agents = path.join(tmp, "agent", "agents", "issue-pipeline");
  for (const dir of [home, root, bin, agents, piDir]) {
    fs.mkdirSync(String(dir), { recursive: true });
  }
  const where = { tmp, home: String(home), root: String(root) };
  assertTemporary(where);
  installBuild(where.root, agents);
  const { origin, wikiOrigin } = seedOrigins(tmp);
  const collaborators = ["bot", "alice"];
  const gh = { dir: String(ghDir), bin: String(bin), origin, collaborators };
  installFlowGh({ ...gh, repo: "o/r", account: "bot" });
  const roles = Object.entries(MODELS).map(([role, id]) => [id, role]);
  installFlowPi(String(bin), Object.fromEntries(roles));
  fs.writeFileSync(path.join(String(piDir), "script.json"), "{}");
  const config = path.join(where.root, `${SLUG}.json`);
  writeConfig(config, origin);
  const env = envOf({ ...where, bin: String(bin), piDir: String(piDir) });
  return {
    ...where,
    config,
    origin,
    wikiOrigin,
    brain: writeBrain(path.join(tmp, "brain")),
    ghDir: String(ghDir),
    piDir: String(piDir),
    env,
    pids: [],
  };
}

/**
 * Throws unless the root and HOME are inside the test's temporary folder
 * and the root isn't pi's own.
 * @param {{ tmp: string, root: string, home: string }} where
 */
function assertTemporary({ tmp, root, home }) {
  const inside = `${tmp}${path.sep}`;
  const piRoot = path.join(os.homedir(), ".pi");
  const temporary = root.startsWith(inside) && home.startsWith(inside);
  if (!temporary || root.startsWith(piRoot)) {
    throw new Error(`pipeline-flow: ${root} is not a temporary root`);
  }
}

/** @param {Flow} flow @param {Record<string, unknown[]>} script */
function scriptPi(flow, script) {
  fs.writeFileSync(
    path.join(flow.piDir, "script.json"),
    JSON.stringify(script),
  );
}

/** @param {string} bare @param {readonly string[]} args @returns {string} */
function bareGit(bare, args) {
  return execFileSync("git", ["--git-dir", bare, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** @param {string} bare @param {string} ref @returns {string | null} */
function refIn(bare, ref) {
  try {
    return bareGit(bare, ["rev-parse", "--verify", "--quiet", ref]);
  } catch {
    return null;
  }
}

export { BASE, bareGit, ISSUE, refIn, SLUG, scriptPi, setUpFlow, WIKI_BRANCH };
