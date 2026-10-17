// A repo's pipeline config: the JSON file each request names, read with the
// defaults in config-schema.ts and checked once here, and the places on disk
// it implies.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG_SCHEMA, DEFAULTS } from "./config-schema.ts";
import { expand, ROOT } from "./pipeline-root.ts";
import { OpsError } from "./process.ts";
import type { Budgets } from "./workflow/budget.ts";
import { sessionBudget } from "./workflow/budget.ts";
import { ROLE_BUDGETS, WRITER_BUDGET_ROLES } from "./workflow/sweep-config.ts";

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const PATH_SEPARATOR = /[\\/]/u;

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

// What the writer budget check reads of a config; a value of another type is
// left to the code that reads it.
const WRITER_BUDGET_KEYS = z.object({
  contextLimits: z.object({ soft: z.number(), hard: z.number() }),
  sessionTokenCap: z.number().catch(Number.POSITIVE_INFINITY),
  roleBudgets: z.record(z.string(), z.number()).nullish().catch(null),
});

// Refuses a config under which the job's own stop at contextLimits.hard could
// never come before the watchdog's kill: a writer's context budget (its
// role's budget, capped by sessionTokenCap) at or below `hard`
// (wrap-up-at-175k, Axlog, 2026-10-17).
function checkWriterBudgets(
  configPath: string,
  raw: Readonly<Record<string, unknown>>,
): void {
  const { contextLimits, sessionTokenCap, roleBudgets } =
    WRITER_BUDGET_KEYS.parse(raw);
  const budgets: Budgets = {
    roles: { ...ROLE_BUDGETS, ...roleBudgets },
    sessionCap: sessionTokenCap,
    softLimit: contextLimits.soft,
    hardLimit: contextLimits.hard,
  };
  for (const role of WRITER_BUDGET_ROLES) {
    const budget = sessionBudget(budgets, role);
    if (contextLimits.hard >= budget) {
      throw new OpsError(
        `config ${configPath}: contextLimits.hard (${contextLimits.hard}) must be below every writer's context budget, but ${role}'s is ${budget} (roleBudgets.${role}, capped by sessionTokenCap), so the watchdog would kill its sessions before the job stops them`,
      );
    }
  }
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
  checkWriterBudgets(String(configPath), parsed.data);
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
  // Where a writer session of issue `n` that runs out of room writes its
  // handoff, which the next session reads.
  handoff: (cfg: Config, n: number): string =>
    path.join(paths.runDir(cfg, n), "handoff.md"),
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

export type { Config, JobCheckout, WikiSettings };
export { loadConfig, paths, publicConfig, tokenEnv, wikiCfg, withCheckout };
