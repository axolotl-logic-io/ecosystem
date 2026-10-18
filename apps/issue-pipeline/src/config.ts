// A repo's pipeline config: the JSON file each request names, read with the
// defaults in config-schema.ts and checked once here, and the places on disk
// it implies.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG_SCHEMA, DEFAULTS } from "./config-schema.ts";
import { JOB_DOCS, JOB_REPO } from "./job/layout.ts";
import { expand, ROOT } from "./pipeline-root.ts";
import { OpsError } from "./process.ts";

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEPARATOR = /[\\/]/u;

// A stage job's own checkout of issue `issue` (#250). While an ops request
// that names it runs, the issue's worktree is `dir`, the job's code checkout,
// and its wiki checkout is `dir`'s sibling (#338); it never comes from the
// config file.
interface JobCheckout {
  issue: number;
  dir: string;
}

type Config = z.infer<typeof CONFIG_SCHEMA> & {
  slug: string;
  checkout?: JobCheckout;
};

interface WikiSettings {
  branch: string;
  dir: string;
}

function checkUsers(configPath: string, users: unknown): void {
  if (!Array.isArray(users) || users.length === 0) {
    throw new OpsError(
      `config ${configPath} must set allowedUsers, a list of GitHub usernames whose issues and comments the pipeline reads`,
    );
  }
  for (const user of users) {
    if (typeof user !== "string" || !GITHUB_USERNAME.test(user)) {
      throw new OpsError(
        `bad GitHub username in allowedUsers: ${JSON.stringify(user)}`,
      );
    }
  }
}

function insideWorktree(entry: unknown): boolean {
  return (
    typeof entry === "string" &&
    entry !== "" &&
    !path.isAbsolute(entry) &&
    !entry.split(PATH_SEPARATOR).includes("..")
  );
}

function checkPractices(configPath: string, practices: unknown): void {
  if (!Array.isArray(practices)) {
    throw new OpsError(
      `config ${configPath}: practices must be a list of paths`,
    );
  }
  for (const entry of practices) {
    if (!insideWorktree(entry)) {
      throw new OpsError(
        `config ${configPath}: practices entry ${JSON.stringify(entry)} must be a path inside the worktree`,
      );
    }
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

const RAW = z.record(z.string(), z.unknown());
const COMMANDS = z.looseObject({ test: z.unknown() });

// The checks whose messages tell an operator what to fix, in the order a
// config is usually written.
function checkRequired(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  const { account, allowedUsers, commands, practices, repo } = raw;
  if (!present(repo)) {
    throw new OpsError(`config ${configPath} is missing "repo"`);
  }
  if (!present(account)) {
    throw new OpsError(`config ${configPath} is missing "account"`);
  }
  const parsedCommands = COMMANDS.safeParse(commands);
  if (!(parsedCommands.success && present(parsedCommands.data.test))) {
    throw new OpsError(
      `config ${configPath} must set commands.test; the pipeline refuses repos without a test command`,
    );
  }
  if (typeof repo !== "string" || !REPO_NAME.test(repo)) {
    throw new OpsError(`bad repo "${String(repo)}"`);
  }
  checkUsers(configPath, allowedUsers);
  checkPractices(configPath, practices);
}

// What the writer budget check reads of a config; a value of another type is
// left to the code that reads it.
type ModelRole = "author" | "implementor" | "reviewer";

// The model a role gets when the config names none for it, or for the
// installed version's roles it maps from: the installed version's default for
// its spec writer, implementer and correctness and security reviewers.
const DEFAULT_MODEL = "anthropic/claude-opus-5-5";

// The installed version's model roles each role reads, in order, when the
// config's models doesn't name the role itself (`three-configurable-models`).
const LEGACY_MODEL_ROLES: Readonly<Record<ModelRole, readonly string[]>> = {
  author: ["spec", "triage"],
  implementor: ["implementer", "fixer"],
  reviewer: ["correctness", "security", "tests"],
};

const MODEL_ROLES: readonly ModelRole[] = ["author", "implementor", "reviewer"];

// Keys the pipeline no longer reads: the session budgets and handoffs, the
// old roles, the claim race, the mechanical test rules and the orchestrator's
// removed extras. A config that sets one still loads, with a warning.
const REMOVED_KEYS: ReadonlySet<string> = new Set([
  "contextLimits",
  "sessionTokenCap",
  "roleBudgets",
  "maxContinuations",
  "issueTokenBudget",
  "rebaseTokenBudget",
  "tokensPerHour",
  "maxTriages",
  "practicesDigest",
  "claimWaitSeconds",
  "claimCandidates",
  "requireNewTests",
  "testPathGlobs",
  "nonCodePathGlobs",
  "orchestratorRoles",
  "silentMinutes",
  "failureStreak",
  "maxSpawnsPerRun",
]);
const REMOVED_PREFIX = "escalationAgent";

const MODEL_IDS = z.record(z.string(), z.unknown()).catch({});

interface ModelChoice {
  models: Record<ModelRole, string>;
  warnings: string[];
}

function textModel(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return null;
}

// Each role's model from the config's `models`: the role's own key, else the
// first installed-version role it maps from, else DEFAULT_MODEL. Every key it
// didn't use is named in a warning.
function chooseModels(raw: unknown): ModelChoice {
  const given = MODEL_IDS.parse(raw ?? {});
  const used = new Set<string>();
  const warnings: string[] = [];
  const models: Record<ModelRole, string> = {
    author: DEFAULT_MODEL,
    implementor: DEFAULT_MODEL,
    reviewer: DEFAULT_MODEL,
  };
  for (const role of MODEL_ROLES) {
    const key = [role, ...LEGACY_MODEL_ROLES[role]].find(
      (name) => textModel(given[name]) !== null,
    );
    if (key === undefined) {
      continue;
    }
    used.add(key);
    models[role] = textModel(given[key]) ?? DEFAULT_MODEL;
    if (key !== role) {
      warnings.push(
        `models.${key} is the installed version's role; the ${role} uses its model ${models[role]} (set models.${role} to choose)`,
      );
    }
  }
  for (const key of Object.keys(given).filter((name) => !used.has(name))) {
    warnings.push(`models.${key} is no longer read; ignoring it`);
  }
  return { models, warnings };
}

function isRemovedKey(key: string): boolean {
  return REMOVED_KEYS.has(key) || key.startsWith(REMOVED_PREFIX);
}

// The config's keys without the removed ones, and a warning for each removed
// key and each model key it maps or ignores.
function withoutRemovedKeys(raw: Readonly<Record<string, unknown>>): {
  kept: Record<string, unknown>;
  warnings: string[];
} {
  const kept: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (isRemovedKey(key)) {
      warnings.push(`${key} is no longer read; ignoring it`);
    } else {
      kept[key] = value;
    }
  }
  const { models } = raw;
  const choice = chooseModels(models);
  return {
    kept: { ...kept, models: choice.models },
    warnings: [...warnings, ...choice.warnings],
  };
}

function loadConfig(configPath: string | undefined): Config {
  const file = expand(configPath ?? "");
  if (file === "" || !fs.existsSync(file)) {
    throw new OpsError(`config not found: ${String(configPath)}`);
  }
  const fromFile = RAW.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const { kept: raw, warnings } = withoutRemovedKeys({
    ...DEFAULTS,
    ...fromFile,
  });
  checkRequired(String(configPath), raw);
  for (const warning of warnings) {
    process.stderr.write(`config ${String(configPath)}: ${warning}\n`);
  }
  const parsed = CONFIG_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new OpsError(
      `config ${String(configPath)}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { checkout: _fromFile, ...data } = parsed.data;
  return { ...data, slug: data.repo.replace("/", "__") };
}

// The config without its token file's path, for replies the workflow logs.
function publicConfig(cfg: Config): Omit<Config, "tokenFile"> {
  const { tokenFile: _hidden, ...rest } = cfg;
  return rest;
}

// The environment that makes gh and git act as the config's account. With no
// tokenFile they use gh's own login (the keyring), which must be `account`.
function tokenEnv(cfg: Config): ReadonlyMap<string, string> {
  if (!present(cfg.tokenFile)) {
    return new Map();
  }
  const file = expand(String(cfg.tokenFile));
  if (!fs.existsSync(file)) {
    throw new OpsError(`token file missing: ${file}`);
  }
  return new Map([["GH_TOKEN", fs.readFileSync(file, "utf8").trim()]]);
}

// The repo's GitHub wiki holds its docs and decisions (Autumn, 2026-10-13). Config
// `wiki: true` or `{ dir, branch }` enables publishing its submodule; off by default.
function wikiCfg(cfg: Config): WikiSettings | null {
  const { wiki } = cfg;
  if (wiki === undefined || wiki === null || wiki === false) {
    return null;
  }
  if (wiki === true) {
    return { branch: "master", dir: "wiki" };
  }
  return {
    branch: wiki.branch ?? "master",
    dir: wiki.dir ?? "wiki",
  };
}

// `cfg` for one ops request: with a checkout, issue `checkout.issue` works
// in `checkout.dir`; other issues keep their worktrees.
function withCheckout(
  cfg: Config,
  checkout: JobCheckout | null | undefined,
): Config {
  if (checkout === null || checkout === undefined) {
    return cfg;
  }
  return { ...cfg, checkout };
}

const paths = {
  branch: (n: number): string => `agent/issue-${n}`,
  clone: (cfg: Config): string => path.join(ROOT, "clones", cfg.slug),
  // Stage job `stage`'s own folder for issue `n`, which holds its code
  // checkout and its wiki checkout side by side (#338).
  jobCheckout: (cfg: Config, n: number, stage: string): string =>
    path.join(ROOT, "work", cfg.slug, "jobs", `issue-${n}-${stage}`),
  // The job's code checkout, cloned from the mirror.
  jobRepo: (cfg: Config, n: number, stage: string): string =>
    path.join(paths.jobCheckout(cfg, n, stage), JOB_REPO),
  // The job's docs alias of the wiki submodule.
  jobDocs: (cfg: Config, n: number, stage: string): string =>
    path.join(paths.jobCheckout(cfg, n, stage), JOB_DOCS),
  // Where a writer session of issue `n` that runs out of room writes its
  // handoff, which the next session reads.
  // Where stage job `key` of issue `n` saves what its checkout `checkout`
  // left uncommitted, before it drops it (#369).
  droppedPatch: (
    cfg: Config,
    n: number,
    key: string,
    checkout: "repo" | "docs",
  ): string =>
    path.join(paths.runDir(cfg, n), "dropped", `${key}-${checkout}.patch`),
  jobLog: (cfg: Config, n: number): string =>
    path.join(paths.runDir(cfg, n), "job.log"),
  // The bare code mirror that job checkouts clone.
  mirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "mirror.git"),
  runDir: (cfg: Config, n: number): string =>
    path.join(ROOT, "runs", cfg.slug, `issue-${n}`),
  // A stage job's model session for launch `key` on issue `n`, as JSONL.
  session: (cfg: Config, n: number, key: string): string =>
    path.join(paths.runDir(cfg, n), "sessions", `${key}.jsonl`),
  // The issue's wiki checkout: in a stage job, its code checkout's sibling;
  // in a lane, a folder of its worktree.
  wiki: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return path.join(path.dirname(cfg.checkout.dir), JOB_DOCS);
    }
    return path.join(paths.worktree(cfg, n), wikiCfg(cfg)?.dir ?? "wiki");
  },
  wikiMirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "wiki-mirror.git"),
  worktree: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return cfg.checkout.dir;
    }
    return path.join(ROOT, "work", cfg.slug, `issue-${n}`);
  },
};

export type { Config, JobCheckout, ModelRole, WikiSettings };
export {
  chooseModels,
  loadConfig,
  paths,
  publicConfig,
  tokenEnv,
  wikiCfg,
  withCheckout,
};
