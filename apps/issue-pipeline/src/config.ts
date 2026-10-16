// A repo's pipeline config: the JSON file each request names, read with the
// defaults below and checked once here, and the places on disk it implies.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expand, ROOT } from "./pipeline-root.ts";
import { OpsError } from "./process.ts";

// A lane waits a random time in this range, in seconds, after claiming an issue.
const SHORTEST_CLAIM_WAIT = 5;
const LONGEST_CLAIM_WAIT = 20;

const DEFAULTS: Readonly<Record<string, unknown>> = {
  baseBranch: "main",
  // false: lanes finish issues already in progress (agent:working, answered
  // questions) but claim no new ones (Autumn, 2026-10-14).
  takeNewWork: true,
  // Issues with any of these labels are never pipeline work, such as deploy tickets.
  skipLabels: [],
  // The files that hold the project's coding practices, relative to the worktree
  // (wiki pages under the wiki's dir, such as "wiki/Decisions.md"). The spec writer
  // reads each in full and specs to them (Autumn, 2026-10-15). Missing files are skipped.
  practices: ["AGENTS.md", "CONTRIBUTING.md"],
  leaseHours: 3,
  issueTokenBudget: 1_000_000,
  // The rebase pool per issue: conflict resolvers, and re-checks after a rebase
  // the merge stage asked for (#201). Reset at merge and restart.
  rebaseTokenBudget: 500_000,
  sessionTokenCap: 150_000,
  maxFixRounds: 2,
  maxCiFixes: 2,
  maxSyncs: 3,
  maxConflictFixes: 2,
  maxTriages: 3,
  claimWaitSeconds: [SHORTEST_CLAIM_WAIT, LONGEST_CLAIM_WAIT],
  claimCandidates: 5,
  requireNewTests: true,
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  testPathGlobs: [
    "test/**",
    "tests/**",
    "**/__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test_*.py",
    "**/*_test.go",
  ],
  nonCodePathGlobs: ["**/*.md", "docs/**"],
  lockfiles: [],
  migrations: null,
  // The orchestrator (#234): caps on live stage jobs, in all and per reader
  // stage, the tokens its jobs may spend an hour, and its seconds between ticks.
  maxJobs: 4,
  stageCaps: { triage: 2, spec: 2, review: 2, accept: 2, security: 2 },
  tokensPerHour: 2_000_000,
  orchestratorIntervalSeconds: 60,
};

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEPARATOR = /[\\/]/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const OPTIONAL_TEXT = z.string().nullish();
// What a stage job's role may hold (src/job/roles.ts): the job variable its
// GH_TOKEN comes from, and the hosts it may reach.
const JOB_ROLE = z
  .object({
    tokenEnv: z.string().regex(ENV_NAME, "must be an env var name").optional(),
    network: z.array(z.string().min(1)).optional(),
  })
  .optional();
const JOB_ROLES = z.object({
  reader: JOB_ROLE,
  writer: JOB_ROLE,
  merger: JOB_ROLE,
});
// What the ops modules read from a config. Every other key passes through to
// the workflow as it is.
const CONFIG_SCHEMA = z.looseObject({
  account: z.string(),
  allowedUsers: z.array(z.string()),
  baseBranch: z.string(),
  claimWaitSeconds: z.tuple([z.number(), z.number()]),
  cloneUrl: OPTIONAL_TEXT,
  commands: z.looseObject({ teardown: OPTIONAL_TEXT, test: z.string() }),
  gitEmail: OPTIONAL_TEXT,
  gitName: OPTIONAL_TEXT,
  jobRoles: JOB_ROLES.nullish(),
  leaseHours: z.number(),
  practices: z.array(z.string()),
  repo: z.string(),
  tokenFile: OPTIONAL_TEXT,
  wiki: z
    .union([
      z.boolean(),
      z.looseObject({
        branch: z.string().optional(),
        dir: z.string().optional(),
        url: z.string().optional(),
      }),
    ])
    .nullish(),
});

// A stage job's own checkout of issue `issue` (#250). While an ops request
// that names it runs, the issue's worktree is `dir`; it never comes from the
// config file.
interface JobCheckout {
  issue: number;
  dir: string;
}

type Config = z.infer<typeof CONFIG_SCHEMA> & {
  slug: string;
  checkout?: JobCheckout;
};
type JobRolesConfig = z.infer<typeof JOB_ROLES>;

interface WikiSettings {
  branch: string;
  dir: string;
  url: string | undefined;
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

function loadConfig(configPath: string | undefined): Config {
  const file = expand(configPath ?? "");
  if (file === "" || !fs.existsSync(file)) {
    throw new OpsError(`config not found: ${String(configPath)}`);
  }
  const raw = RAW.parse({
    ...DEFAULTS,
    ...RAW.parse(JSON.parse(fs.readFileSync(file, "utf8"))),
  });
  checkRequired(String(configPath), raw);
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
// `wiki: true` or `{ dir, branch, url }` turns it on; it is off by default.
function wikiCfg(cfg: Config): WikiSettings | null {
  const { wiki } = cfg;
  if (wiki === undefined || wiki === null || wiki === false) {
    return null;
  }
  if (wiki === true) {
    return { branch: "master", dir: "wiki", url: undefined };
  }
  return {
    branch: wiki.branch ?? "master",
    dir: wiki.dir ?? "wiki",
    url: wiki.url,
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
  // Stage job `stage`'s own checkout of issue `n`, cloned from the mirror.
  jobCheckout: (cfg: Config, n: number, stage: string): string =>
    path.join(ROOT, "work", cfg.slug, "jobs", `issue-${n}-${stage}`),
  jobLog: (cfg: Config, n: number): string =>
    path.join(paths.runDir(cfg, n), "job.log"),
  // The bare mirrors of the repo and its wiki that job checkouts clone.
  mirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "mirror.git"),
  runDir: (cfg: Config, n: number): string =>
    path.join(ROOT, "runs", cfg.slug, `issue-${n}`),
  // A stage job's model session for launch `key` on issue `n`, as JSONL.
  session: (cfg: Config, n: number, key: string): string =>
    path.join(paths.runDir(cfg, n), "sessions", `${key}.jsonl`),
  wiki: (cfg: Config, n: number): string =>
    path.join(paths.worktree(cfg, n), wikiCfg(cfg)?.dir ?? "wiki"),
  wikiClone: (cfg: Config): string =>
    path.join(ROOT, "clones", `${cfg.slug}.wiki`),
  wikiMirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "wiki-mirror.git"),
  worktree: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return cfg.checkout.dir;
    }
    return path.join(ROOT, "work", cfg.slug, `issue-${n}`);
  },
};

export type { Config, JobCheckout, JobRolesConfig, WikiSettings };
export { loadConfig, paths, publicConfig, tokenEnv, wikiCfg, withCheckout };
